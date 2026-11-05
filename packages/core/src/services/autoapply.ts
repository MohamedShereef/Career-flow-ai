/**
 * Auto-apply: everything except driving the browser (that lives in the worker).
 *
 *   start → [worker: open page, read form] → planAnswers → [worker: fill, screenshot]
 *         → savePreview (awaiting approval) → approve → [worker: re-fill, verify hash,
 *           irreversible submit] → recordOutcome (evidence, ledger)
 *
 * Safety rules enforced here:
 * - Answers come only from the profile, saved answers, the approved CV, or an AI
 *   answer grounded in the profile (numbers not in the profile are rejected).
 *   Legal, identity, protected-category, work-authorisation and consent questions
 *   are never answered by AI — they go to the questions inbox once.
 * - The approval is bound to a content hash of every answer and file; the worker
 *   refuses to submit if what it is about to send differs.
 * - The permanent ledger blocks a second submission for the same job, and an
 *   unclear outcome is never retried automatically.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  applicationEvents,
  automationSettings,
  applicationPreviews,
  applications,
  approvals,
  cvTailorings,
  documents,
  errorRecords,
  jobEvaluations,
  jobs,
  pendingQuestions,
  portalLogins,
  submissionEvidence,
  submissionLedger,
} from "@careerflow/db";
import { js, structured } from "../ai";
import { decrypt, encrypt, sha256 } from "../crypto";
import { AppError, notFound } from "../errors";
import { numbersIn } from "../fact-guard";
import { normalizeQuestion } from "../normalize";
import { getStorage } from "../storage";
import type { Db, Executor } from "../types";
import * as answersSvc from "./answers";
import { audit } from "./audit";
import * as profile from "./profile";
import * as queue from "./queue";
import { getSettings } from "./settings";

// ───────────────────────── Types shared with the worker ─────────────────────────

export type FieldType = "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "listbox" | "combobox" | "radio" | "checkbox" | "checkbox_group" | "file";

export interface FormField {
  /** Stable across visits: derived from the field's name/id/label, not its position. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  accept?: string | null;
}

export type Blocker = {
  kind: "captcha" | "login_required" | "login_failed" | "verification_required" | "form_missing" | "unsupported_ats" | "navigation_timeout" | "fill_failed" | "job_board";
  detail: string;
  /** The portal that asked for a sign-in, so the user can save a login for it. */
  host?: string;
};

export interface FormSnapshot {
  url: string;
  atsKind: string;
  pageTitle: string;
  fields: FormField[];
  blockers: Blocker[];
}

export type AnswerValue = { kind: "text"; value: string } | { kind: "bool"; value: boolean } | { kind: "multi"; values: string[] } | { kind: "file"; doc: "cv" | "cover_letter" };

export type AnswerSource = "profile" | "saved_answer" | "ai" | "document";

export interface PlannedAnswer {
  key: string;
  label: string;
  type: FieldType;
  value: AnswerValue;
  source: AnswerSource;
  /** True when a person must look at it even under autopilot. */
  needsReview: boolean;
}

export interface Plan {
  answers: PlannedAnswer[];
  missing: FormField[];
}

// ───────────────────────── Question rules ─────────────────────────

/** Never answered by AI and never guessed: asked once in the inbox, then reused. */
const ASK_ONCE = /\b(authori[sz]ed|authori[sz]ation|eligible to work|right to work|sponsor|visa|work permit|iqama|transferable|relocat|notice period|start date|available to start|consent|agree|acknowledge|privacy|terms|gdpr|data protection|reference|referee|how did you hear|source|referred)\b/;

const norm = (s: string) => normalizeQuestion(s.replace(/\*/g, " "));

function bestOption(options: string[] | undefined, wanted: string): string | null {
  if (!options?.length) return wanted;
  const w = wanted.trim().toLowerCase();
  const exact = options.find((o) => o.trim().toLowerCase() === w);
  if (exact) return exact;
  const yes = /^(yes|y|true|نعم)$/i.test(w);
  const no = /^(no|n|false|لا)$/i.test(w);
  if (yes) return options.find((o) => /^\s*yes\b/i.test(o)) ?? null;
  if (no) return options.find((o) => /^\s*no\b/i.test(o)) ?? null;
  const contains = options.filter((o) => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()));
  return contains.length === 1 ? contains[0]! : null;
}

function asValue(field: FormField, raw: string): AnswerValue | null {
  const v = raw.trim();
  if (!v) return null;
  if (field.type === "checkbox") {
    if (/^(yes|true|y|i agree|agree|نعم)$/i.test(v)) return { kind: "bool", value: true };
    if (/^(no|false|n|لا)$/i.test(v)) return { kind: "bool", value: false };
    return null;
  }
  if (field.type === "checkbox_group") {
    const picks = v.split(/[;,\n]/).map((x) => bestOption(field.options, x)).filter((x): x is string => !!x);
    return picks.length ? { kind: "multi", values: [...new Set(picks)] } : null;
  }
  if (field.type === "select" || field.type === "radio" || field.type === "listbox") {
    const o = bestOption(field.options, v);
    return o ? { kind: "text", value: o } : null;
  }
  return { kind: "text", value: v };
}

const isResume = (l: string) => /\b(resume|résumé|cv|curriculum)\b/.test(l);
const isCoverLetter = (l: string) => /\bcover\b|\bmotivation letter\b/.test(l);

// ───────────────────────── Planning answers ─────────────────────────

interface PlanContext {
  userId: string;
  userEmail: string;
  applicationId: string;
  job: { id: string; title: string; companyName: string; description: string | null };
  hasCoverLetter: boolean;
  coverLetterText: string | null;
}

const AI_SCHEMA = js.obj({
  answers: js.arr(
    js.obj({
      key: js.str(),
      answer: js.strN("The answer, or null if the candidate's facts don't answer it"),
    }),
  ),
});

const AI_SYSTEM = `You fill job-application questions for the candidate, using ONLY the candidate facts provided.
Rules:
- If the facts don't clearly answer a question, return null for it. Never guess, never invent employers, dates, numbers, certifications or skills.
- For questions with options, answer with exactly one of the options (or several separated by ";" when it is a multi-select).
- Free-text answers: 1-4 sentences, first person, professional, grounded in the facts. Use only figures that appear in the facts.
- Do not answer anything about salary, legal declarations, identity numbers, protected characteristics, visas or consent.`;

export async function planAnswers(db: Db, ctx: PlanContext, snapshot: FormSnapshot): Promise<Plan> {
  const [p, exps, quals, skills, facts] = await Promise.all([
    profile.getProfile(db, ctx.userId),
    profile.listExperiences(db, ctx.userId),
    profile.listQualifications(db, ctx.userId),
    profile.listSkills(db, ctx.userId),
    profile.listCareerFacts(db, ctx.userId, true),
  ]);
  const current = exps.find((e) => e.isCurrent) ?? exps[0];
  const nameParts = (p.fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const first = nameParts[0] ?? null;
  const last = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;

  // label pattern → profile value
  const PROFILE_RULES: Array<[RegExp, string | null | undefined]> = [
    [/\b(first|given|fore) ?name\b/, first],
    [/\b(last|family|sur) ?name\b|\bsurname\b/, last],
    [/^(full )?name$|\bfull name\b|\byour name\b|\blegal name\b/, p.fullName],
    [/\be ?mail\b/, p.contactEmail ?? ctx.userEmail],
    [/\b(phone|mobile|telephone|cell|whatsapp)\b/, p.phone],
    [/\blinked ?in\b/, p.linkedinUrl],
    [/\b(current )?(city|location)\b|\bwhere are you (based|located)\b/, p.city],
    [/\bcountry of residence\b|\bresidence country\b|\bcountry\b/, p.residencyCountry],
    [/\bnationality\b|\bcitizenship\b/, p.nationality],
    [/\b(current|most recent|present) (company|employer|organi[sz]ation)\b/, current?.employer],
    [/\b(current|most recent|present) (job )?(title|position|role|designation)\b|^job title$|^headline$/, current?.title ?? p.headline],
    [/\byears of (relevant |total |professional )?experience\b|\bhow many years\b/, p.yearsExperience != null ? String(p.yearsExperience) : null],
    [/\bexpected (salary|compensation)\b|\bsalary expectation/, p.expectedSalary],
    [/\bcurrent (salary|compensation)\b/, p.currentSalary],
    [/\bnotice period\b/, p.noticePeriodDays != null ? `${p.noticePeriodDays} days` : null],
  ];

  const answers: PlannedAnswer[] = [];
  const missing: FormField[] = [];
  const forAi: FormField[] = [];

  for (const f of snapshot.fields) {
    const l = norm(f.label);
    const sensitivity = answersSvc.classifySensitivity(f.label);

    if (f.type === "file") {
      if (isResume(l) || (!isCoverLetter(l) && !answers.some((a) => a.value.kind === "file" && a.value.doc === "cv"))) {
        answers.push({ key: f.key, label: f.label, type: f.type, value: { kind: "file", doc: "cv" }, source: "document", needsReview: false });
      } else if (isCoverLetter(l) && ctx.hasCoverLetter) {
        answers.push({ key: f.key, label: f.label, type: f.type, value: { kind: "file", doc: "cover_letter" }, source: "document", needsReview: false });
      } else if (f.required) missing.push(f);
      continue;
    }

    if (isCoverLetter(l) && (f.type === "textarea" || f.type === "text") && ctx.coverLetterText) {
      answers.push({ key: f.key, label: f.label, type: f.type, value: { kind: "text", value: ctx.coverLetterText }, source: "document", needsReview: false });
      continue;
    }

    // 1) the user's own saved answer for this exact question (employer-specific first)
    const saved = await answersSvc.findAnswer(db, ctx.userId, f.label, ctx.job.companyName, { markUsed: true });
    if (saved) {
      const v = asValue(f, saved.answer);
      if (v) {
        answers.push({ key: f.key, label: f.label, type: f.type, value: v, source: "saved_answer", needsReview: saved.requiresReview });
        continue;
      }
    }

    // 2) a standard field filled from the profile
    const rule = PROFILE_RULES.find(([re]) => re.test(l));
    if (rule && rule[1]) {
      const v = asValue(f, rule[1]);
      if (v) {
        answers.push({ key: f.key, label: f.label, type: f.type, value: v, source: "profile", needsReview: false });
        continue;
      }
    }

    // 3) questions a person must answer (once)
    if (sensitivity !== "normal" || ASK_ONCE.test(l) || f.type === "checkbox") {
      if (f.required) missing.push(f);
      continue;
    }

    // 4) anything else: AI, grounded in the profile
    forAi.push(f);
  }

  if (forAi.length) {
    const factsText = [
      `Name: ${p.fullName ?? ""}`,
      `Headline: ${p.headline ?? ""}`,
      `Summary: ${p.summary ?? ""}`,
      `Years of experience: ${p.yearsExperience ?? "not stated"}`,
      `Location: ${p.city ?? ""} ${p.residencyCountry ?? ""}`,
      ...exps.map((e) => `Role: ${e.title} at ${e.employer} (${e.startDate?.slice(0, 7)} – ${e.isCurrent ? "present" : e.endDate?.slice(0, 7) ?? "?"})\n${e.description ?? ""}`),
      `Qualifications: ${quals.map((q) => `${q.name}${q.state === "in_progress" ? " (in progress)" : ""}`).join("; ")}`,
      `Skills: ${skills.map((s) => s.name).join(", ")}`,
      `Verified achievements: ${facts.map((f) => f.statement).join(" | ")}`,
    ].join("\n");
    const allowedNumbers = new Set(numbersIn(factsText));
    try {
      const { data } = await structured<{ answers: Array<{ key: string; answer: string | null }> }>({
        db,
        userId: ctx.userId,
        stage: "form_answers",
        agent: "application",
        entityType: "application",
        entityId: ctx.applicationId,
        inputSummary: `${forAi.length} questions for ${ctx.job.title} @ ${ctx.job.companyName}`,
        system: AI_SYSTEM,
        user:
          `CANDIDATE FACTS:\n"""\n${factsText.slice(0, 14_000)}\n"""\n\nJOB: ${ctx.job.title} at ${ctx.job.companyName}\n${(ctx.job.description ?? "").slice(0, 3000)}\n\n` +
          `QUESTIONS:\n${JSON.stringify(forAi.map((f) => ({ key: f.key, question: f.label, type: f.type, options: f.options ?? null })))}`,
        schemaName: "form_answers",
        schema: AI_SCHEMA,
        maxOutputTokens: 4000,
        outcome: (d) => `${d.answers.filter((a) => a.answer).length}/${forAi.length} answered`,
      });
      for (const f of forAi) {
        const a = data.answers.find((x) => x.key === f.key)?.answer;
        // Any figure the AI uses must already be in the profile.
        const grounded = a && numbersIn(a).every((n) => allowedNumbers.has(n));
        const v = grounded ? asValue(f, a!) : null;
        if (v) answers.push({ key: f.key, label: f.label, type: f.type, value: v, source: "ai", needsReview: true });
        else if (f.required) missing.push(f);
      }
    } catch (err) {
      if (err instanceof AppError && ["ai_auth", "ai_rate_limited"].includes(err.code)) throw err;
      for (const f of forAi) if (f.required) missing.push(f);
    }
  }

  return { answers, missing };
}

/** File each unanswered required question in the inbox (deduplicated). */
export async function askMissing(db: Db, ctx: PlanContext, missing: FormField[]) {
  for (const f of missing) {
    await answersSvc.resolveOrAsk(db, ctx.userId, {
      questionText: f.label,
      employerName: ctx.job.companyName,
      jobTitle: ctx.job.title,
      applicationId: ctx.applicationId,
      jobId: ctx.job.id,
      fieldType: f.type,
      options: f.options ?? null,
      required: true,
      context: `Asked by ${ctx.job.companyName} for ${ctx.job.title}`,
    });
  }
}

// ───────────────────────── Hashing ─────────────────────────

export function contentHash(input: { applicationId: string; jobId: string; answers: PlannedAnswer[]; cvSha: string | null; coverSha: string | null }) {
  const answers = [...input.answers]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => [a.key, a.value.kind === "file" ? `file:${a.value.doc}` : JSON.stringify(a.value)]);
  return sha256(JSON.stringify({ a: input.applicationId, j: input.jobId, answers, cv: input.cvSha, cover: input.coverSha }));
}

const aadPreview = (userId: string, applicationId: string) => `preview:${userId}:${applicationId}`;

// ───────────────────────── Helpers ─────────────────────────

async function event(db: Executor, userId: string, applicationId: string, kind: (typeof applicationEvents.$inferInsert)["kind"], stage: string, message: string, details?: unknown) {
  await db.insert(applicationEvents).values({ userId, applicationId, kind, stage, message, details: details ?? null });
}

async function storeFile(db: Executor, userId: string, kind: "evidence_screenshot" | "evidence_html", bytes: Buffer, mime: string, filename: string, label: string) {
  const ext = mime === "image/png" ? "png" : mime === "text/html" ? "html" : "bin";
  const key = `users/${userId}/${kind}/${crypto.randomUUID()}.${ext}`;
  await getStorage().put(key, bytes, mime);
  const [doc] = await db
    .insert(documents)
    .values({ userId, kind, storageKey: key, filename, mimeType: mime, sizeBytes: bytes.length, sha256: sha256(bytes), label })
    .returning();
  return doc!;
}

export async function loadFile(db: Executor, documentId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt) throw notFound("Document");
  const bytes = await getStorage().get(doc.storageKey);
  if (sha256(bytes) !== doc.sha256) throw new AppError("integrity", "A stored file failed its integrity check.");
  return { doc, bytes };
}

// ───────────────────────── Starting ─────────────────────────

export const SUPPORTED_ATS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "career_site"] as const;

/** Sites that repost jobs. Their pages rarely hold the employer's form; we follow their Apply link instead. */
const JOB_BOARD_HOSTS =
  /(^|\.)(indeed\.[a-z.]+|glassdoor\.[a-z.]+|bayt\.com|naukrigulf\.com|gulftalent\.com|recruit\.net|jooble\.org|talent\.com|jobrapido\.com|whatjobs\.com|adzuna\.[a-z.]+|careerjet\.[a-z.]+|jobsora\.com|simplyhired\.[a-z.]+|ziprecruiter\.[a-z.]+|monster\.[a-z.]+|drjobpro\.com|drjob\.[a-z.]+|akhtaboot\.com|wuzzuf\.net|tanqeeb\.com|laimoon\.com|expatriates\.com|dubizzle\.com|jobleads\.com|lensa\.com|learn4good\.com|jobtome\.com|jobted\.[a-z.]+|neuvoo\.[a-z.]+|jora\.com|mourjan\.com|founditgulf\.com|monstergulf\.com|naukri\.com|shine\.com|xpatjobs\.[a-z.]+|ksa-jobs\.com|saudijobs\.[a-z.]+|jobzmall\.com|ladders\.com|dice\.com|google\.com)$/;

export function isJobBoardUrl(url: string) {
  const k = atsFromUrl(url);
  return k === "job_board" || k === "linkedin";
}

/** The link the agent should use: one the user pasted for this application wins over the discovered one. */
export function applyUrlFor(app: { checkpointData: unknown }, job: { applyUrl: string }) {
  const override = (app.checkpointData as { applyUrl?: string } | null)?.applyUrl;
  return override || job.applyUrl;
}

/** Best guess of the application system from the link. */
export function atsFromUrl(url: string): string {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (/greenhouse\.io$/.test(h)) return "greenhouse";
  if (/lever\.co$/.test(h)) return "lever";
  if (/ashbyhq\.com$/.test(h)) return "ashby";
  if (/workable\.com$/.test(h)) return "workable";
  if (/smartrecruiters\.com$/.test(h)) return "smartrecruiters";
  if (/myworkdayjobs\.com$|workday\.com$/.test(h)) return "workday";
  if (/successfactors\.|jobs2web\.com$|sapsf\./.test(h)) return "successfactors";
  if (/taleo\.net$|oraclecloud\.com$/.test(h)) return "oracle";
  if (/(^|\.)linkedin\.com$/.test(h)) return "linkedin";
  if (JOB_BOARD_HOSTS.test(h)) return "job_board";
  return "career_site";
}

export async function startAutoApply(db: Db, userId: string, input: { jobId: string; tailoringId?: string | null; origin?: "user" | "autopilot"; applyUrl?: string | null }) {
  const settings = await getSettings(db, userId);
  if (!settings.automationConsentAt) throw new AppError("no_consent", "Turn on “Let CareerFlow apply for me” in Settings → Consent first.");
  const [job] = await db.select().from(jobs).where(eq(jobs.id, input.jobId));
  if (!job) throw notFound("Job");
  if (job.status !== "active") throw new AppError("job_closed", "This posting is no longer open.");

  const [done] = await db.select().from(submissionLedger).where(and(eq(submissionLedger.userId, userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey)));
  if (done && done.state !== "abandoned") throw new AppError("already_applied", done.state === "submitted" ? "You already applied to this job." : "A previous attempt on this job had an unclear outcome. Check your email before trying again.");

  const [t] = input.tailoringId
    ? await db.select().from(cvTailorings).where(and(eq(cvTailorings.id, input.tailoringId), eq(cvTailorings.userId, userId)))
    : await db.select().from(cvTailorings).where(and(eq(cvTailorings.userId, userId), eq(cvTailorings.jobId, job.id))).orderBy(desc(cvTailorings.createdAt)).limit(1);
  if (!t?.cvDocumentId) throw new AppError("no_cv", "Tailor your CV for this job first.");
  if (!t.approvedAt && input.origin !== "autopilot") throw new AppError("not_approved", "Approve the tailored CV first.");

  let applyUrl: string | null = null;
  if (input.applyUrl) {
    try {
      const u = new URL(input.applyUrl.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      applyUrl = u.toString();
    } catch {
      throw new AppError("invalid_url", "Paste the full link to the employer's application page (starting with https://).");
    }
    if (atsFromUrl(applyUrl) === "linkedin") throw new AppError("linkedin", "CareerFlow doesn't apply through LinkedIn. Paste the employer's own careers-site link.");
  }
  if (!applyUrl) {
    // Keep an employer link found or pasted on an earlier attempt.
    const [prev] = await db.select({ cp: applications.checkpointData }).from(applications).where(and(eq(applications.userId, userId), eq(applications.jobId, job.id)));
    applyUrl = (prev?.cp as { applyUrl?: string } | null)?.applyUrl ?? null;
  }
  const ats = atsFromUrl(applyUrl ?? job.applyUrl);
  const cpData = { tailoringId: t.id, origin: input.origin ?? "user", ats, ...(applyUrl ? { applyUrl } : {}) };
  const [app] = await db
    .insert(applications)
    .values({ userId, jobId: job.id, employerKey: job.employerKey, status: "processing", tailoredCvDocumentId: t.cvDocumentId, coverLetterDocumentId: t.coverLetterDocumentId, checkpoint: "queued_prepare", checkpointData: cpData })
    .onConflictDoUpdate({
      target: [applications.userId, applications.jobId],
      set: { status: "processing", statusReason: null, tailoredCvDocumentId: t.cvDocumentId, coverLetterDocumentId: t.coverLetterDocumentId, checkpoint: "queued_prepare", checkpointData: cpData, updatedAt: new Date() },
    })
    .returning();
  if (["submitted_unverified", "confirmed_by_email", "interview"].includes(app!.status)) throw new AppError("already_applied", "You already applied to this job.");

  await db.update(approvals).set({ invalidatedAt: new Date(), invalidatedReason: "restarted" }).where(and(eq(approvals.applicationId, app!.id), isNull(approvals.consumedAt), isNull(approvals.invalidatedAt)));
  await event(db, userId, app!.id, "status_change", "start", input.origin === "autopilot" ? "Autopilot started this application." : "You asked CareerFlow to apply.");
  await queue.enqueue(db, { kind: "application.prepare", userId, payload: { applicationId: app!.id }, dedupeKey: `apply:prepare:${app!.id}`, maxAttempts: 2, timeoutSeconds: 900 });
  return app!;
}

/** Everything the worker needs to open and fill the form. */
export async function loadContext(db: Db, applicationId: string) {
  const [row] = await db
    .select({ a: applications, j: jobs })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.id, applicationId));
  if (!row) throw notFound("Application");
  const tailoringId = (row.a.checkpointData as { tailoringId?: string } | null)?.tailoringId;
  const [t] = tailoringId ? await db.select().from(cvTailorings).where(eq(cvTailorings.id, tailoringId)) : [];
  const [user] = await db.execute(sql`SELECT email FROM users WHERE id = ${row.a.userId}`).then((r) => r.rows as Array<{ email: string }>);
  const letter = (t?.content as { coverLetter?: string | null } | undefined)?.coverLetter ?? null;
  const ctx: PlanContext = {
    userId: row.a.userId,
    userEmail: user?.email ?? "",
    applicationId,
    job: { id: row.j.id, title: row.j.title, companyName: row.j.companyName, description: row.j.description },
    hasCoverLetter: !!row.a.coverLetterDocumentId,
    coverLetterText: letter ? `Dear Hiring Team,\n\n${letter}` : null,
  };
  return { app: row.a, job: row.j, tailoring: t ?? null, ctx };
}

// ───────────────────────── Worker → state transitions ─────────────────────────

const ERROR_TEXT: Record<Blocker["kind"], string> = {
  captcha: "The page shows a robot check (CAPTCHA / “verify you are human”). CareerFlow doesn't bypass those. Open it yourself and apply with your CV — or paste the employer's own application link below.",
  login_required: "This employer's portal needs an account. Create one there yourself (once), then save its email and password below — CareerFlow signs in and continues the application.",
  login_failed: "The saved login didn't work on this portal. Check the email and password in Settings → Saved logins (or reset it on the portal), then try again.",
  verification_required: "The portal asked for a verification code or email confirmation. Sign in there once yourself to complete it, then press “Try automatic again”.",
  form_missing: "We couldn't find an application form on the employer's page. Open it and apply with your CV.",
  unsupported_ats: "This application system isn't supported for automatic filling yet. Open the page and apply with your CV.",
  job_board: "This link goes to a job site that reposts jobs, not the employer's own application page, and it doesn't link through to one. Find the job on the employer's careers site and paste that link below — CareerFlow continues from there.",
  navigation_timeout: "The employer's page didn't load. We'll try again later.",
  fill_failed: "Some fields on the employer's form couldn't be filled automatically. Open the page and apply with your CV.",
};

export async function recordBlocker(db: Db, applicationId: string, b: Blocker, taskId?: string) {
  const [a] = await db.select().from(applications).where(eq(applications.id, applicationId));
  if (!a) return;
  const category = ({ captcha: "captcha", login_required: "login_required", unsupported_ats: "unsupported_ats", navigation_timeout: "navigation_timeout", form_missing: "form_missing", fill_failed: "readback_mismatch", job_board: "unsupported_ats", login_failed: "login_required", verification_required: "login_required" } as const)[b.kind];
  const [err] = await db
    .insert(errorRecords)
    .values({ userId: a.userId, applicationId, taskId: taskId ?? null, stage: "prepare", category, rootCauseKey: `${category}:${a.employerKey}`, userMessage: ERROR_TEXT[b.kind], technicalDetail: { detail: b.detail } })
    .returning();
  const reason = b.kind === "fill_failed" ? `${ERROR_TEXT.fill_failed} (${b.detail.slice(0, 300)})` : ERROR_TEXT[b.kind];
  const cp = { ...((a.checkpointData as Record<string, unknown> | null) ?? {}), ...(b.host ? { loginHost: b.host } : {}) };
  await db.update(applications).set({ status: "needs_user_action", statusReason: reason, checkpoint: `blocked_${b.kind}`, checkpointData: cp, lastErrorId: err!.id, updatedAt: new Date() }).where(eq(applications.id, applicationId));
  await event(db, a.userId, applicationId, "error", "prepare", reason, { detail: b.detail });
}

export async function recordWaitingForAnswers(db: Db, applicationId: string, count: number) {
  const [a] = await db.select().from(applications).where(eq(applications.id, applicationId));
  if (!a) return;
  const msg = `The employer asks ${count} question${count === 1 ? "" : "s"} only you can answer. Answer ${count === 1 ? "it" : "them"} in Profile → Questions and the application continues automatically.`;
  await db.update(applications).set({ status: "needs_user_action", statusReason: msg, checkpoint: "waiting_answers", updatedAt: new Date() }).where(eq(applications.id, applicationId));
  await event(db, a.userId, applicationId, "status_change", "prepare", msg);
}

/** When the user answers an inbox question, resume any application that was waiting for it. */
export async function resumeWaiting(db: Db, userId: string) {
  const waiting = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.userId, userId), eq(applications.status, "needs_user_action"), eq(applications.checkpoint, "waiting_answers")));
  let resumed = 0;
  for (const w of waiting) {
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pendingQuestions)
      .where(and(eq(pendingQuestions.applicationId, w.id), eq(pendingQuestions.status, "open")));
    if ((open?.n ?? 0) > 0) continue;
    await db.update(applications).set({ status: "processing", statusReason: null, checkpoint: "queued_prepare", updatedAt: new Date() }).where(eq(applications.id, w.id));
    await event(db, userId, w.id, "status_change", "prepare", "All questions answered — continuing.");
    await queue.enqueue(db, { kind: "application.prepare", userId, payload: { applicationId: w.id }, dedupeKey: `apply:prepare:${w.id}`, maxAttempts: 2, timeoutSeconds: 900 });
    resumed++;
  }
  return resumed;
}

export async function savePreview(
  db: Db,
  input: { applicationId: string; url: string; atsKind: string; answers: PlannedAnswer[]; screenshot: Buffer; skippedOptional: number; steps?: number },
) {
  const { app } = await loadContext(db, input.applicationId);
  const [cv, cover] = await Promise.all([
    app.tailoredCvDocumentId ? db.select({ sha: documents.sha256 }).from(documents).where(eq(documents.id, app.tailoredCvDocumentId)) : Promise.resolve([]),
    app.coverLetterDocumentId ? db.select({ sha: documents.sha256 }).from(documents).where(eq(documents.id, app.coverLetterDocumentId)) : Promise.resolve([]),
  ]);
  const hash = contentHash({ applicationId: app.id, jobId: app.jobId, answers: input.answers, cvSha: cv[0]?.sha ?? null, coverSha: cover[0]?.sha ?? null });
  const shot = await storeFile(db, app.userId, "evidence_screenshot", input.screenshot, "image/png", "form-preview.png", "Filled form (before submit)");

  return db.transaction(async (tx) => {
    const [{ v }] = (await tx.select({ v: sql<number>`coalesce(max(${applicationPreviews.version}), 0)::int` }).from(applicationPreviews).where(eq(applicationPreviews.applicationId, app.id))) as [{ v: number }];
    const [preview] = await tx
      .insert(applicationPreviews)
      .values({
        userId: app.userId,
        applicationId: app.id,
        version: v + 1,
        contentHash: hash,
        answersEnc: encrypt(JSON.stringify({ url: input.url, atsKind: input.atsKind, answers: input.answers, skippedOptional: input.skippedOptional, steps: input.steps ?? 1 }), aadPreview(app.userId, app.id)),
        resumeDocumentId: app.tailoredCvDocumentId,
        coverLetterDocumentId: app.coverLetterDocumentId,
        screenshotDocumentId: shot.id,
      })
      .returning();
    await tx.update(approvals).set({ invalidatedAt: new Date(), invalidatedReason: "new_preview" }).where(and(eq(approvals.applicationId, app.id), isNull(approvals.consumedAt), isNull(approvals.invalidatedAt)));
    await tx.update(applications).set({ status: "awaiting_approval", statusReason: null, checkpoint: "awaiting_approval", updatedAt: new Date() }).where(eq(applications.id, app.id));
    await event(tx, app.userId, app.id, "status_change", "preview", `Form filled (${input.answers.length} answers). Waiting for your approval.`);
    return preview!;
  });
}

function readPreview(p: typeof applicationPreviews.$inferSelect) {
  return JSON.parse(decrypt(p.answersEnc, aadPreview(p.userId, p.applicationId))) as { url: string; atsKind: string; answers: PlannedAnswer[]; skippedOptional: number; steps?: number };
}

// ───────────────────────── Approval & submission ─────────────────────────

export async function autopilotStatus(db: Executor, userId: string) {
  const s = await getSettings(db, userId);
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${approvals.applicationId})::int` })
    .from(approvals)
    .innerJoin(applications, eq(applications.id, approvals.applicationId))
    .where(and(eq(approvals.userId, userId), sql`${approvals.consumedAt} IS NOT NULL`, inArray(applications.status, ["submitted_unverified", "confirmed_by_email", "interview", "rejected", "closed"])));
  const approvedSubmitted = r?.n ?? 0;
  const unlocked = approvedSubmitted >= s.manualApprovalUntilCount;
  return {
    approvedSubmitted,
    needed: s.manualApprovalUntilCount,
    unlocked,
    prepareEnabled: !!s.automationConsentAt && s.autopilotEnabled,
    autoSubmit: !!s.automationConsentAt && s.continuousSubmissionEnabled && unlocked,
  };
}

/** Under unlocked autopilot, a preview is approved automatically only when nothing needs a person. */
export async function maybeAutoApprove(db: Db, previewId: string) {
  const [p] = await db.select().from(applicationPreviews).where(eq(applicationPreviews.id, previewId));
  if (!p) return false;
  const st = await autopilotStatus(db, p.userId);
  if (!st.autoSubmit) return false;
  const data = readPreview(p);
  if (data.answers.some((a) => a.needsReview)) return false;
  await approve(db, p.userId, previewId, "agent");
  return true;
}

export async function approve(db: Db, userId: string, previewId: string, actor: "user" | "agent" = "user") {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(applicationPreviews).where(and(eq(applicationPreviews.id, previewId), eq(applicationPreviews.userId, userId)));
    if (!p) throw notFound("Preview");
    const [latest] = await tx.select({ id: applicationPreviews.id }).from(applicationPreviews).where(eq(applicationPreviews.applicationId, p.applicationId)).orderBy(desc(applicationPreviews.version)).limit(1);
    if (latest?.id !== p.id) throw new AppError("stale_preview", "A newer version of this application exists. Review that one.");
    const [a] = await tx.select().from(applications).where(eq(applications.id, p.applicationId)).for("update");
    if (!a || a.status !== "awaiting_approval") throw new AppError("not_awaiting", "This application isn't waiting for approval.");
    const [ap] = await tx
      .insert(approvals)
      .values({ userId, applicationId: a.id, previewId: p.id, contentHash: p.contentHash, jobId: a.jobId, employerKey: a.employerKey })
      .returning();
    await tx.update(applications).set({ status: "processing", approvedPreviewId: p.id, checkpoint: "approved", updatedAt: new Date() }).where(eq(applications.id, a.id));
    const tailoringId = (a.checkpointData as { tailoringId?: string } | null)?.tailoringId;
    if (tailoringId) await tx.update(cvTailorings).set({ approvedAt: sql`coalesce(${cvTailorings.approvedAt}, now())` }).where(eq(cvTailorings.id, tailoringId));
    await event(tx, userId, a.id, "user_action", "approve", actor === "user" ? "You approved this application for submission." : "Approved automatically by autopilot (every answer came from your profile or saved answers).");
    await audit(tx, { userId, actor, action: "application.approved", entityType: "application", entityId: a.id, metadata: { previewId: p.id, contentHash: p.contentHash } });
    await queue.enqueue(tx, { kind: "application.submit", userId, payload: { applicationId: a.id, approvalId: ap!.id }, dedupeKey: `apply:submit:${a.id}`, maxAttempts: 3, timeoutSeconds: 900 });
    return ap!;
  });
}

/** The approved answers, verified unchanged. */
export async function loadApproved(db: Db, applicationId: string, approvalId: string) {
  const [ap] = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.applicationId, applicationId)));
  if (!ap || ap.invalidatedAt) throw new AppError("approval_invalid", "This approval is no longer valid.");
  if (ap.consumedAt) throw new AppError("approval_used", "This approval was already used.");
  const [p] = await db.select().from(applicationPreviews).where(eq(applicationPreviews.id, ap.previewId));
  if (!p || p.contentHash !== ap.contentHash) throw new AppError("approval_mismatch", "The approved content changed. A new review is needed.");
  return { approval: ap, preview: p, data: readPreview(p) };
}

/** Recompute the hash of what the worker is about to send; must equal the approved one. */
export async function verifyBeforeSubmit(db: Db, applicationId: string, approvalId: string, answers: PlannedAnswer[]) {
  const { approval } = await loadApproved(db, applicationId, approvalId);
  const { app } = await loadContext(db, applicationId);
  const shas = await db.select({ id: documents.id, sha: documents.sha256 }).from(documents).where(inArray(documents.id, [app.tailoredCvDocumentId, app.coverLetterDocumentId].filter((x): x is string => !!x)));
  const sha = (id: string | null) => (id ? shas.find((s) => s.id === id)?.sha ?? null : null);
  const hash = contentHash({ applicationId, jobId: app.jobId, answers, cvSha: sha(app.tailoredCvDocumentId), coverSha: sha(app.coverLetterDocumentId) });
  if (hash !== approval.contentHash) throw new AppError("approval_mismatch", "What would be sent differs from what you approved.");
}

/**
 * Reserve the job in the permanent ledger right before the final click.
 * Throws if this job was ever submitted or left in an unclear state.
 */
export async function reserveSubmission(db: Db, applicationId: string, approvalId: string) {
  const { app, job } = await loadContext(db, applicationId);
  return db.transaction(async (tx) => {
    const ins = await tx
      .insert(submissionLedger)
      .values({ userId: app.userId, jobDedupeKey: job.dedupeKey, employerKey: app.employerKey, applicationId, approvalId, state: "attempting" })
      .onConflictDoNothing()
      .returning();
    if (!ins.length) {
      const [l] = await tx.select().from(submissionLedger).where(and(eq(submissionLedger.userId, app.userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey))).for("update");
      if (l && l.state !== "abandoned") throw new AppError("already_submitted", l.state === "submitted" ? "Already submitted." : "A previous attempt is unresolved.");
      await tx.update(submissionLedger).set({ state: "attempting", applicationId, approvalId, updatedAt: new Date() }).where(eq(submissionLedger.id, l!.id));
    }
    await event(tx, app.userId, applicationId, "browser_action", "submit", "Pressing the employer's Submit button.");
  });
}

export async function recordOutcome(
  db: Db,
  input: { applicationId: string; approvalId: string; outcome: "confirmed" | "not_submitted" | "uncertain"; url: string; summary: string; screenshot?: Buffer | null; errors?: string[] },
) {
  const { app, job } = await loadContext(db, input.applicationId);
  const shot = input.screenshot ? await storeFile(db, app.userId, "evidence_screenshot", input.screenshot, "image/png", "after-submit.png", "Page after pressing Submit") : null;
  await db.transaction(async (tx) => {
    const now = new Date();
    const ledgerWhere = and(eq(submissionLedger.userId, app.userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey));
    if (input.outcome === "confirmed") {
      await tx.update(submissionLedger).set({ state: "submitted", updatedAt: now }).where(ledgerWhere);
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, input.approvalId));
      await tx.update(applications).set({ status: "submitted_unverified", statusReason: null, submittedAt: now, websiteAcknowledgedAt: now, checkpoint: "submitted", updatedAt: now }).where(eq(applications.id, app.id));
      await tx.insert(submissionEvidence).values({ userId: app.userId, applicationId: app.id, kind: "confirmation_page", level: "website", summary: input.summary, url: input.url, documentId: shot?.id ?? null });
      await event(tx, app.userId, app.id, "evidence", "submit", `Submitted. The employer's site confirmed: “${input.summary.slice(0, 160)}”`);
    } else if (input.outcome === "not_submitted") {
      await tx.update(submissionLedger).set({ state: "abandoned", updatedAt: now }).where(ledgerWhere);
      await tx.update(approvals).set({ invalidatedAt: now, invalidatedReason: "form_rejected" }).where(eq(approvals.id, input.approvalId));
      const msg = `The employer's form didn't accept the application${input.errors?.length ? `: ${input.errors.slice(0, 3).join("; ")}` : ""}. Nothing was sent.`;
      const [err] = await tx
        .insert(errorRecords)
        .values({ userId: app.userId, applicationId: app.id, stage: "submit", category: "readback_mismatch", rootCauseKey: `form_rejected:${app.employerKey}`, userMessage: msg, technicalDetail: { errors: input.errors ?? [], url: input.url } })
        .returning();
      await tx.update(applications).set({ status: "needs_user_action", statusReason: msg, checkpoint: "form_rejected", lastErrorId: err!.id, updatedAt: now }).where(eq(applications.id, app.id));
      await event(tx, app.userId, app.id, "error", "submit", msg);
    } else {
      await tx.update(submissionLedger).set({ state: "uncertain", updatedAt: now }).where(ledgerWhere);
      await tx.update(approvals).set({ consumedAt: now }).where(eq(approvals.id, input.approvalId));
      const msg = "We pressed Submit but the page didn't clearly confirm it. Check your email for a receipt. CareerFlow won't try this job again on its own.";
      const [err] = await tx
        .insert(errorRecords)
        .values({ userId: app.userId, applicationId: app.id, stage: "submit", category: "uncertain_submission", rootCauseKey: `uncertain:${app.employerKey}`, userMessage: msg, technicalDetail: { url: input.url, summary: input.summary } })
        .returning();
      await tx.update(applications).set({ status: "needs_user_action", statusReason: msg, submittedAt: now, checkpoint: "uncertain", lastErrorId: err!.id, updatedAt: now }).where(eq(applications.id, app.id));
      if (shot) await tx.insert(submissionEvidence).values({ userId: app.userId, applicationId: app.id, kind: "screenshot", level: "website", summary: "Page after Submit (no clear confirmation)", url: input.url, documentId: shot.id });
      await event(tx, app.userId, app.id, "error", "submit", msg);
    }
  });
}

/** The user confirms an unclear attempt did (or didn't) go through. */
export async function resolveUncertain(db: Db, userId: string, applicationId: string, wentThrough: boolean) {
  const { app, job } = await loadContext(db, applicationId);
  if (app.userId !== userId) throw notFound("Application");
  if (app.checkpoint !== "uncertain") throw new AppError("not_uncertain", "This application isn't waiting for that.");
  const now = new Date();
  await db.update(submissionLedger).set({ state: wentThrough ? "submitted" : "abandoned", updatedAt: now }).where(and(eq(submissionLedger.userId, userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey)));
  await db.update(applications).set({ status: wentThrough ? "submitted_unverified" : "needs_user_action", statusReason: wentThrough ? null : "Not submitted. You can start it again.", checkpoint: wentThrough ? "submitted" : "abandoned", updatedAt: now }).where(eq(applications.id, applicationId));
  await event(db, userId, applicationId, "user_action", "submit", wentThrough ? "You confirmed the application went through." : "You confirmed the application did not go through.");
}

export async function cancel(db: Db, userId: string, applicationId: string) {
  const [a] = await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
  if (!a) throw notFound("Application");
  if (["submitted_unverified", "confirmed_by_email", "interview"].includes(a.status) || a.checkpoint === "uncertain") throw new AppError("cannot_cancel", "This application was already sent.");
  await db.update(approvals).set({ invalidatedAt: new Date(), invalidatedReason: "cancelled" }).where(and(eq(approvals.applicationId, a.id), isNull(approvals.consumedAt), isNull(approvals.invalidatedAt)));
  await db.update(applications).set({ status: "withdrawn", statusReason: "Cancelled by you.", checkpoint: "cancelled", updatedAt: new Date() }).where(eq(applications.id, a.id));
  await db.execute(sql`UPDATE tasks SET status = 'cancelled', finished_at = now() WHERE status = 'queued' AND kind IN ('application.prepare','application.submit') AND payload->>'applicationId' = ${a.id}`);
  await event(db, userId, a.id, "user_action", "cancel", "You cancelled this application.");
}

// ───────────────────────── Reading ─────────────────────────

export async function getDetail(db: Db, userId: string, applicationId: string) {
  const [row] = await db
    .select({ a: applications, j: jobs })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
  if (!row) throw notFound("Application");
  const [preview] = await db.select().from(applicationPreviews).where(eq(applicationPreviews.applicationId, applicationId)).orderBy(desc(applicationPreviews.version)).limit(1);
  const [events, evidence, questions] = await Promise.all([
    db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, applicationId)).orderBy(desc(applicationEvents.createdAt)).limit(100),
    db.select().from(submissionEvidence).where(eq(submissionEvidence.applicationId, applicationId)).orderBy(desc(submissionEvidence.capturedAt)),
    db.select().from(pendingQuestions).where(and(eq(pendingQuestions.applicationId, applicationId), eq(pendingQuestions.status, "open"))),
  ]);
  return { app: row.a, job: row.j, preview: preview ? { ...preview, data: readPreview(preview) } : null, events, evidence, questions };
}

export async function awaitingApprovalCount(db: Executor, userId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(applications).where(and(eq(applications.userId, userId), eq(applications.status, "awaiting_approval")));
  return r?.n ?? 0;
}

// ───────────────────────── Autopilot selection ─────────────────────────

/** Recommended jobs not yet applied to, best first, on systems we can fill. */
export async function autopilotCandidates(db: Db, userId: string, limit: number) {
  const s = await getSettings(db, userId);
  const rows = await db
    .select({ j: jobs, score: jobEvaluations.score })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(
      and(
        eq(jobEvaluations.userId, userId),
        isNull(jobEvaluations.supersededAt),
        eq(jobEvaluations.decision, "recommended"),
        sql`${jobEvaluations.score} >= ${s.matchThreshold}`,
        eq(jobs.status, "active"),
        sql`NOT EXISTS (SELECT 1 FROM applications a WHERE a.user_id = ${userId} AND a.job_id = ${jobs.id})`,
        sql`NOT EXISTS (SELECT 1 FROM submission_ledger l WHERE l.user_id = ${userId} AND l.job_dedupe_key = ${jobs.dedupeKey})`,
      ),
    )
    .orderBy(desc(jobEvaluations.score))
    .limit(limit * 4);
  // Job-board-only links rarely reach a form; leave those for the user.
  // Account portals (Workday, SuccessFactors…) qualify once the user saved a login for that portal.
  const saved = new Set((await db.select({ host: portalLogins.host }).from(portalLogins).where(eq(portalLogins.userId, userId))).map((r) => r.host));
  const host = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  return rows
    .filter((r) => {
      const k = atsFromUrl(r.j.applyUrl);
      return !!r.j.description && ((SUPPORTED_ATS as readonly string[]).includes(k) || (["workday", "successfactors", "oracle"].includes(k) && saved.has(host(r.j.applyUrl))));
    })
    .slice(0, limit);
}

// ───────────────────────── Autopilot switches ─────────────────────────

export async function setAutopilot(db: Db, userId: string, input: { prepare?: boolean; autoSubmit?: boolean }) {
  const s = await getSettings(db, userId);
  if ((input.prepare || input.autoSubmit) && !s.automationConsentAt) throw new AppError("no_consent", "Allow “Fill and submit applications” in Settings → Consent first.");
  if (input.autoSubmit) {
    const st = await autopilotStatus(db, userId);
    if (!st.unlocked) throw new AppError("locked", `Submitting without asking unlocks after ${st.needed} applications you approved were sent (${st.approvedSubmitted} so far).`);
  }
  const set: Partial<typeof automationSettings.$inferInsert> = { updatedAt: new Date() };
  if (input.prepare !== undefined) set.autopilotEnabled = input.prepare;
  if (input.autoSubmit !== undefined) set.continuousSubmissionEnabled = input.autoSubmit;
  await db.update(automationSettings).set(set).where(eq(automationSettings.userId, userId));
  await audit(db, { userId, actor: "user", action: "autopilot.updated", metadata: input });
  if (input.prepare) await queue.enqueue(db, { kind: "autopilot.run", userId, dedupeKey: "autopilot:manual", timeoutSeconds: 1200 });
}

/** Switch this application to the employer's own page (found by CareerFlow or pasted by the user). */
export async function useEmployerLink(db: Db, applicationId: string, url: string, note: string) {
  const [a] = await db.select().from(applications).where(eq(applications.id, applicationId));
  if (!a) return;
  const data = { ...((a.checkpointData as Record<string, unknown> | null) ?? {}), applyUrl: url, ats: atsFromUrl(url) };
  await db.update(applications).set({ checkpointData: data, updatedAt: new Date() }).where(eq(applications.id, applicationId));
  await event(db, a.userId, applicationId, "browser_action", "prepare", note, { url });
}

/**
 * A site submitted the application when "Next" was pressed during preparation.
 * Record it exactly as it happened: sent, without the final approval step.
 */
export async function recordUnplannedSubmit(db: Db, applicationId: string, info: { url: string; summary: string; screenshot: Buffer | null }) {
  const { app, job } = await loadContext(db, applicationId);
  const shot = info.screenshot ? await storeFile(db, app.userId, "evidence_screenshot", info.screenshot, "image/png", "after-next.png", "Page after pressing Next") : null;
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(submissionLedger).values({ userId: app.userId, jobDedupeKey: job.dedupeKey, employerKey: app.employerKey, applicationId, state: "submitted" }).onConflictDoUpdate({ target: [submissionLedger.userId, submissionLedger.jobDedupeKey], set: { state: "submitted", applicationId, updatedAt: now } });
    await tx.update(applications).set({ status: "submitted_unverified", statusReason: "The employer's site sent the application when CareerFlow pressed “Next”, before your final review.", submittedAt: now, websiteAcknowledgedAt: now, checkpoint: "submitted", updatedAt: now }).where(eq(applications.id, applicationId));
    await tx.insert(submissionEvidence).values({ userId: app.userId, applicationId, kind: "confirmation_page", level: "website", summary: info.summary || "Confirmation shown", url: info.url, documentId: shot?.id ?? null });
    await event(tx, app.userId, applicationId, "error", "prepare", "Heads-up: this employer's form submitted on “Next” (no separate Submit step). It was sent with the answers shown here, before your final approval.");
    await audit(tx, { userId: app.userId, actor: "agent", action: "application.unplanned_submit", entityType: "application", entityId: applicationId, metadata: { url: info.url } });
  });
}
