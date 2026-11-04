/**
 * CV Tailoring Agent. The model chooses emphasis and wording; the facts come
 * from the database:
 * - work history (employers, titles, dates) and qualifications are rendered
 *   from the profile, never from model text;
 * - highlights are referenced by id and rendered from verified facts only;
 * - every AI-written sentence passes the FactGuard (no unsupported numbers,
 *   no certifications the user doesn't hold).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { cvTailorings, documents } from "@careerflow/db";
import { z } from "zod";
import { js, structured } from "../ai";
import { sha256 } from "../crypto";
import { renderCvPdf, renderLetterPdf, type CvDocument } from "../cv-pdf";
import { AppError, notFound } from "../errors";
import { FactGuard } from "../fact-guard";
import { getStorage } from "../storage";
import type { Db } from "../types";
import { audit } from "./audit";
import * as profile from "./profile";

export const tailorInputSchema = z.object({
  jobTitle: z.string().trim().min(2).max(200),
  companyName: z.string().trim().min(1).max(200),
  jobDescription: z.string().trim().min(80, "Paste the full job description (at least a few lines).").max(30_000),
  includeCoverLetter: z.boolean().default(true),
  jobId: z.string().uuid().nullish(),
});

interface AiTailoring {
  headline: string;
  summary: string;
  experiences: Array<{ experienceId: string; bullets: string[] }>;
  highlightIds: string[];
  skills: string[];
  matchedRequirements: string[];
  gaps: string[];
  changes: string[];
  coverLetter: string | null;
}

export interface TailoredContent extends AiTailoring {
  removedByGuard: string[];
}

const SCHEMA = js.obj({
  headline: js.str("Professional headline aligned to the target role, based on the candidate's real current title"),
  summary: js.str("3-4 sentence professional summary"),
  experiences: js.arr(js.obj({ experienceId: js.str(), bullets: js.arr(js.str()) }), "Every role from the profile, most relevant bullets first"),
  highlightIds: js.arr(js.str(), "Ids of verified highlights to feature, most relevant first (max 5)"),
  skills: js.arr(js.str(), "Skills from the candidate's list, most relevant first (max 18)"),
  matchedRequirements: js.arr(js.str()),
  gaps: js.arr(js.str(), "Job requirements the profile does not evidence — never hide these by inventing"),
  changes: js.arr(js.str(), "Plain-language list of what you emphasised or reworded compared with the original"),
  coverLetter: js.strN("Cover letter body (3-4 short paragraphs, no greeting/sign-off/date/address), or null if not requested"),
});

const SYSTEM = `You tailor a candidate's CV to one job. You are writing for the candidate; their reputation depends on accuracy.
Hard rules:
- Use ONLY facts present in the candidate profile JSON. Never invent employers, titles, dates, numbers, budgets, team sizes, tools, certifications, or responsibilities.
- You may reorder, select, shorten and rephrase existing bullet content to mirror the job's vocabulary when the meaning is the same.
- Bullets for a role may only use what that same role's description says. Never move achievements between roles.
- Any number you write must appear in the profile exactly (same value). If unsure, leave numbers out.
- Qualifications marked in_progress must never be described as held or certified.
- Include every role (by experienceId) so the history has no gaps; older or less relevant roles may have 1-2 bullets.
- 3-6 bullets for relevant roles, each starting with a strong verb, max ~30 words.
- Put requirements the candidate doesn't meet in "gaps". Do not mention gaps in the CV or letter.
- Write in English, concise, ATS-friendly (no tables, no emojis).`;

function fmtMonth(d: string | null, current: boolean) {
  if (current || !d) return current ? "Present" : "";
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(new Date(d));
}

export async function tailorCv(db: Db, userId: string, input: unknown) {
  const parsed = tailorInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_tailor", parsed.error.issues[0]?.message ?? "Invalid input.");
  const job = parsed.data;

  const [p, exps, quals, skills, facts] = await Promise.all([
    profile.getProfile(db, userId),
    profile.listExperiences(db, userId),
    profile.listQualifications(db, userId),
    profile.listSkills(db, userId),
    profile.listCareerFacts(db, userId, true),
  ]);
  if (!exps.length) throw new AppError("no_experience", "Add your work experience first (or import it from your CV) so there's something to tailor.");
  if (!p.fullName) throw new AppError("no_name", "Add your full name in My Profile first.");

  const profileJson = {
    headline: p.headline,
    summary: p.summary,
    yearsExperience: p.yearsExperience,
    industries: p.industries,
    experiences: exps.map((e) => ({
      experienceId: e.id,
      title: e.title,
      employer: e.employer,
      location: e.location,
      start: e.startDate,
      end: e.isCurrent ? "present" : e.endDate,
      description: e.description,
    })),
    qualifications: quals.map((q) => ({ name: q.name, issuer: q.issuer, kind: q.kind, state: q.state })),
    skills: skills.map((s) => s.name),
    verifiedHighlights: facts.map((f) => ({ id: f.id, statement: f.statement, meaning: f.meaning })),
  };

  const { data, decisionId } = await structured<AiTailoring>({
    db,
    userId,
    stage: "cv_tailoring",
    agent: "cv_tailoring",
    inputSummary: `${job.jobTitle} at ${job.companyName}; profile v${p.profileVersion}`,
    system: SYSTEM,
    user:
      `TARGET JOB: ${job.jobTitle} at ${job.companyName}\n\nJOB DESCRIPTION:\n"""\n${job.jobDescription}\n"""\n\n` +
      `CANDIDATE PROFILE (the only source of facts):\n${JSON.stringify(profileJson)}\n\n` +
      (job.includeCoverLetter ? "Also write the cover letter body." : "Set coverLetter to null."),
    schemaName: "cv_tailoring",
    schema: SCHEMA,
    maxOutputTokens: 10000,
    outcome: (d) => `${d.experiences.length} roles, ${d.highlightIds.length} highlights, ${d.gaps.length} gaps`,
  });

  // ── Deterministic guards ──
  const earliest = exps.reduce((min, e) => (e.startDate < min ? e.startDate : min), exps[0]!.startDate);
  const computedYears = Math.floor((Date.now() - new Date(earliest).getTime()) / (365.25 * 86_400_000));
  const guard = new FactGuard(
    [
      p.summary,
      p.headline,
      p.yearsExperience,
      computedYears,
      ...exps.flatMap((e) => [e.title, e.description, e.startDate?.slice(0, 4), e.endDate?.slice(0, 4)]),
      ...quals.map((q) => q.name),
      ...facts.flatMap((f) => [f.statement, f.meaning, f.numericValue === null ? null : Number(f.numericValue)]),
      ...skills.map((s) => s.name),
    ],
    quals.filter((q) => q.state === "held").map((q) => q.name),
  );

  const expById = new Map(exps.map((e) => [e.id, e]));
  const factById = new Map(facts.map((f) => [f.id, f]));
  const skillByLower = new Map(skills.map((s) => [s.name.toLowerCase(), s.name]));

  const aiExps = new Map(data.experiences.filter((e) => expById.has(e.experienceId)).map((e) => [e.experienceId, e]));
  const tailored: TailoredContent = {
    headline: guard.paragraph(data.headline) || p.headline || exps[0]!.title,
    summary: guard.paragraph(data.summary),
    // Keep every real role in chronological order, whatever the model returned.
    experiences: exps.map((e) => ({
      experienceId: e.id,
      bullets: (aiExps.get(e.id)?.bullets ?? []).map((b) => b.trim()).filter((b) => b && guard.keep(b)).slice(0, 7),
    })),
    highlightIds: [...new Set(data.highlightIds)].filter((id) => factById.has(id)).slice(0, 5),
    skills: [...new Set(data.skills.map((s) => skillByLower.get(s.toLowerCase())).filter((s): s is string => !!s))].slice(0, 18),
    matchedRequirements: data.matchedRequirements.slice(0, 15),
    gaps: data.gaps.slice(0, 15),
    changes: data.changes.slice(0, 15),
    coverLetter: job.includeCoverLetter && data.coverLetter ? guard.letter(data.coverLetter) : null,
    removedByGuard: guard.removed,
  };
  // Roles the model left empty fall back to the user's own description lines.
  for (const t of tailored.experiences) {
    if (!t.bullets.length) {
      const own = (expById.get(t.experienceId)!.description ?? "").split(/\n+/).map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
      t.bullets = own.slice(0, 4);
    }
  }
  if (!tailored.skills.length) tailored.skills = skills.slice(0, 18).map((s) => s.name);

  // ── Render ──
  const contact = [p.city, p.phone, p.contactEmail, p.linkedinUrl].filter((x): x is string => !!x);
  const cvDoc: CvDocument = {
    name: p.fullName,
    headline: tailored.headline,
    contact,
    summary: tailored.summary || p.summary,
    highlights: tailored.highlightIds.map((id) => factById.get(id)!.statement),
    experiences: tailored.experiences.map((t) => {
      const e = expById.get(t.experienceId)!;
      return {
        title: e.title,
        employer: e.employer,
        location: e.location,
        dates: `${fmtMonth(e.startDate, false)} - ${fmtMonth(e.endDate, e.isCurrent)}`,
        bullets: t.bullets,
      };
    }),
    qualifications: quals.map(
      (q) => `${q.name}${q.issuer ? `, ${q.issuer}` : ""}${q.state === "in_progress" ? " (in progress)" : q.obtainedOn ? ` (${q.obtainedOn.slice(0, 4)})` : ""}`,
    ),
    skills: tailored.skills,
  };

  const safe = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40);
  const base = `${safe(p.fullName)}_${safe(job.companyName)}_${safe(job.jobTitle)}`;

  const store = async (bytes: Buffer, kind: "cv_tailored" | "cover_letter", filename: string) => {
    const key = `users/${userId}/${kind}/${randomUUID()}.pdf`;
    await getStorage().put(key, bytes, "application/pdf");
    const [doc] = await db
      .insert(documents)
      .values({ userId, kind, storageKey: key, filename, mimeType: "application/pdf", sizeBytes: bytes.length, sha256: sha256(bytes), label: `${job.companyName} – ${job.jobTitle}` })
      .returning();
    return doc!;
  };

  const cvPdf = await renderCvPdf(cvDoc);
  const cvRow = await store(cvPdf, "cv_tailored", `${base}_CV.pdf`);
  let letterRow: typeof cvRow | null = null;
  if (tailored.coverLetter) {
    const letterPdf = await renderLetterPdf({
      name: p.fullName,
      contact,
      date: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" }).format(new Date()),
      recipient: `Hiring Team\n${job.companyName}`,
      body: `Dear Hiring Team,\n\n${tailored.coverLetter}`,
    });
    letterRow = await store(letterPdf, "cover_letter", `${base}_Cover_Letter.pdf`);
  }

  const [row] = await db
    .insert(cvTailorings)
    .values({
      userId,
      jobId: job.jobId ?? null,
      jobTitle: job.jobTitle,
      companyName: job.companyName,
      jobDescription: job.jobDescription,
      profileVersion: p.profileVersion,
      content: tailored,
      guardRemovals: tailored.removedByGuard,
      cvDocumentId: cvRow.id,
      coverLetterDocumentId: letterRow?.id ?? null,
      aiDecisionId: decisionId,
    })
    .returning();
  await audit(db, { userId, actor: "agent", action: "cv.tailored", entityType: "cv_tailoring", entityId: row!.id, metadata: { removed: tailored.removedByGuard.length } });
  return row!;
}

export async function listTailorings(db: Db, userId: string) {
  return db
    .select({ id: cvTailorings.id, jobTitle: cvTailorings.jobTitle, companyName: cvTailorings.companyName, createdAt: cvTailorings.createdAt, approvedAt: cvTailorings.approvedAt, cvDocumentId: cvTailorings.cvDocumentId, coverLetterDocumentId: cvTailorings.coverLetterDocumentId })
    .from(cvTailorings)
    .where(eq(cvTailorings.userId, userId))
    .orderBy(desc(cvTailorings.createdAt))
    .limit(50);
}

export async function getTailoring(db: Db, userId: string, id: string) {
  const [row] = await db.select().from(cvTailorings).where(and(eq(cvTailorings.id, id), eq(cvTailorings.userId, userId)));
  if (!row) throw notFound("Tailored CV");
  return { ...row, content: row.content as TailoredContent };
}

/** Approval freezes this version for use in applications. */
export async function approveTailoring(db: Db, userId: string, id: string) {
  const res = await db.update(cvTailorings).set({ approvedAt: new Date() }).where(and(eq(cvTailorings.id, id), eq(cvTailorings.userId, userId))).returning();
  if (!res.length) throw notFound("Tailored CV");
  await audit(db, { userId, actor: "user", action: "cv.tailoring_approved", entityType: "cv_tailoring", entityId: id });
}
