/**
 * Gmail tracking over IMAP with a Google app password.
 *
 * - Only job-related emails are read: from employers the user applied to, from
 *   application systems, or with application/interview-type subjects.
 * - Those are classified by AI (receipt, interview, assessment, rejection, offer…)
 *   and matched to an application, which updates its status and evidence.
 * - Only metadata and a one-sentence summary are stored — never the email body.
 */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { applicationEvents, applications, gmailIntegrations, jobs, processedEmails, submissionEvidence, submissionLedger } from "@careerflow/db";
import { js, structured } from "../ai";
import { decrypt, encrypt, keyedHash } from "../crypto";
import { AppError } from "../errors";
import { employerKey } from "../normalize";
import type { Db, Executor } from "../types";
import { audit } from "./audit";
import { setConsent } from "./settings";

// ───────────────────────── Mail source (IMAP or a test double) ─────────────────────────

export interface MailHeader {
  uid: number;
  messageId: string;
  from: { address: string; name: string };
  subject: string;
  date: Date;
  bulk: boolean;
}

export interface MailSource {
  /** New messages since the cursor (or since `since` on first sync). */
  list(cursor: { uidValidity: string | null; lastUid: number }, since: Date, limit: number): Promise<{ uidValidity: string; headers: MailHeader[] }>;
  /** Plain text of one message (truncated). */
  text(uid: number): Promise<string>;
  close(): Promise<void>;
}

export type MailSourceFactory = (creds: { email: string; appPassword: string }) => Promise<MailSource>;

export const imapSource: MailSourceFactory = async ({ email, appPassword }) => {
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: email, pass: appPassword }, logger: false, socketTimeout: 60_000 });
  try {
    await client.connect();
  } catch (err) {
    const msg = String((err as { responseText?: string }).responseText ?? (err as Error).message ?? err);
    if (/auth|credential|invalid|password|AUTHENTICATIONFAILED|Application-specific/i.test(msg)) {
      throw new AppError("gmail_auth", "Google rejected the login. Use a 16-letter app password (not your normal Gmail password), with 2-Step Verification turned on.");
    }
    throw new AppError("gmail_unreachable", "Couldn't reach Gmail right now. Try again in a minute.");
  }
  const lock = await client.getMailboxLock("INBOX");
  return {
    async list(cursor, since, limit) {
      const mb = client.mailbox as { uidValidity?: bigint | number } | false;
      const uidValidity = String(mb ? mb.uidValidity ?? "" : "");
      let uids: number[] = [];
      if (cursor.uidValidity === uidValidity && cursor.lastUid > 0) {
        const found = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
        uids = (found || []).filter((u) => u > cursor.lastUid);
      } else {
        uids = (await client.search({ since }, { uid: true })) || [];
      }
      uids = uids.sort((a, b) => a - b).slice(-limit);
      const headers: MailHeader[] = [];
      if (uids.length) {
        for await (const m of client.fetch(uids.join(","), { uid: true, envelope: true, headers: ["list-unsubscribe", "precedence"] }, { uid: true })) {
          const e = m.envelope;
          const from = e?.from?.[0];
          const h = m.headers?.toString("utf8") ?? "";
          headers.push({
            uid: m.uid,
            messageId: e?.messageId ?? `uid-${uidValidity}-${m.uid}`,
            from: { address: (from?.address ?? "").toLowerCase(), name: from?.name ?? "" },
            subject: e?.subject ?? "",
            date: e?.date ? new Date(e.date) : new Date(),
            bulk: /list-unsubscribe|precedence:\s*(bulk|list)/i.test(h),
          });
        }
      }
      return { uidValidity, headers };
    },
    async text(uid) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return "";
      const parsed = await simpleParser(msg.source.subarray(0, 400_000));
      const text = parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ") : "");
      return text.replace(/\s+/g, " ").trim().slice(0, 8000);
    },
    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
};

// ───────────────────────── Connect / disconnect ─────────────────────────

const aad = (userId: string) => `gmail:${userId}`;

export async function connect(db: Db, userId: string, input: { email: string; appPassword: string }, source: MailSourceFactory = imapSource) {
  const email = input.email.trim().toLowerCase();
  const appPassword = input.appPassword.replace(/\s+/g, "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("invalid_email", "Enter your Gmail address.");
  if (!/^[a-z]{16}$/i.test(appPassword)) throw new AppError("invalid_app_password", "An app password is 16 letters (Google shows it in 4 groups of 4). Your normal Gmail password won't work here.");
  // Prove it works before saving anything.
  const s = await source({ email, appPassword });
  await s.close();
  const values = { userId, googleEmail: email, authMethod: "app_password", appPasswordEnc: encrypt(appPassword, aad(userId)), scope: "imap:inbox:read", status: "connected" as const, lastError: null, historyId: null, updatedAt: new Date() };
  await db.insert(gmailIntegrations).values(values).onConflictDoUpdate({ target: gmailIntegrations.userId, set: values });
  await setConsent(db, userId, "email_tracking", true);
  await audit(db, { userId, actor: "user", action: "gmail.connected", metadata: { email } });
}

export async function disconnect(db: Db, userId: string) {
  await db.delete(gmailIntegrations).where(eq(gmailIntegrations.userId, userId));
  await setConsent(db, userId, "email_tracking", false);
  await audit(db, { userId, actor: "user", action: "gmail.disconnected" });
}

export async function status(db: Executor, userId: string) {
  const [g] = await db.select().from(gmailIntegrations).where(eq(gmailIntegrations.userId, userId));
  if (!g) return null;
  return { email: g.googleEmail, status: g.status, lastSyncAt: g.lastSyncAt, lastError: g.lastError };
}

// ───────────────────────── Relevance & classification ─────────────────────────

const ATS_SENDERS = /(greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|myworkday\.com|workday\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|smartrecruiters\.com|workablemail\.com|workable\.com|ashbyhq\.com|icims\.com|taleo\.net|oraclecloud\.com|jobvite\.com|recruitee\.com|teamtailor\.com|breezy\.hr|bamboohr\.com|zohorecruit\.[a-z.]+|personio\.(de|com)|pinpointhq\.com|eightfold\.ai|phenompeople\.com|hackerrank\.com|codility\.com|testgorilla\.com|hirevue\.com|shl\.com|calendly\.com)$/i;
const SUBJECT_HINT = /\b(application|applied|apply|candidate|candidacy|interview|assessment|test invitation|offer|position|vacancy|role at|thank you for (your )?(interest|applying)|regret|unfortunately|next steps|shortlist|recruit|hiring|talent acquisition)\b|مقابلة|طلبك|التقديم|وظيفة|ترشيح/i;
const JOB_ALERT = /\b(job alert|jobs? for you|new jobs|recommended jobs|jobs you may|people are hiring|daily digest)\b/i;

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length >= 4 && !["arabia", "saudi", "company", "group", "limited", "careers", "talent", "noreply", "reply", "mail", "jobs", "hiring", "team"].includes(w));

type AppRow = { id: string; status: string; employerKey: string; company: string; title: string; jobId: string; dedupeKey: string };

function relevant(h: MailHeader, apps: AppRow[]) {
  const domain = h.from.address.split("@")[1] ?? "";
  if (JOB_ALERT.test(h.subject)) return false;
  if (ATS_SENDERS.test(domain)) return true;
  const hay = `${domain} ${h.from.name} ${h.subject}`.toLowerCase();
  if (apps.some((a) => words(a.company).some((w) => hay.includes(w)))) return true;
  return !h.bulk && SUBJECT_HINT.test(h.subject);
}

interface AiEmail {
  classification: "application_receipt" | "interview_invitation" | "assessment" | "status_update" | "rejection" | "offer" | "recruiter_outreach" | "other";
  employer: string | null;
  jobTitle: string | null;
  summary: string;
  times: string[];
  actionNeeded: boolean;
  confidence: number;
}

const SCHEMA = js.obj({
  classification: js.enumOf(["application_receipt", "interview_invitation", "assessment", "status_update", "rejection", "offer", "recruiter_outreach", "other"]),
  employer: js.strN("Hiring company named in the email"),
  jobTitle: js.strN("Job title named in the email"),
  summary: js.str("One sentence, factual, what the email says and asks"),
  times: js.arr(js.str(), "Interview/assessment dates-times stated in the email, ISO 8601 with offset; assume +03:00 if no zone. Empty if none stated."),
  actionNeeded: js.bool(),
  confidence: js.num(),
});

const SYSTEM = `You read one email a job seeker received and classify it. Use only what the email says.
- application_receipt: confirms an application was received/submitted.
- interview_invitation: invites to an interview or asks to book one.
- assessment: asks to take a test/assessment/case study.
- rejection: the application won't progress.
- offer: a job offer.
- recruiter_outreach: a recruiter or company reaching out about a role the candidate didn't apply to.
- status_update: other updates on an application.
- other: newsletters, job alerts, marketing, anything else.
actionNeeded = true when the candidate must reply, book, or complete something.`;

function matchApp(apps: AppRow[], h: MailHeader, ai: AiEmail): { status: "matched" | "ambiguous" | "unmatched"; app?: AppRow; candidates: string[] } {
  const domain = h.from.address.split("@")[1] ?? "";
  const hay = `${domain} ${h.from.name} ${h.subject} ${ai.employer ?? ""}`.toLowerCase();
  const titleWords = new Set(words(`${ai.jobTitle ?? ""} ${h.subject}`));
  const scored = apps
    .map((a) => {
      let score = 0;
      if (words(a.company).some((w) => hay.includes(w))) score += 2;
      if (ai.employer && employerKey(ai.employer) === a.employerKey) score += 2;
      score += Math.min(3, words(a.title).filter((w) => titleWords.has(w)).length);
      return { a, score };
    })
    .filter((x) => x.score >= 2)
    .sort((x, y) => y.score - x.score);
  if (!scored.length) return { status: "unmatched", candidates: [] };
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return { status: "ambiguous", candidates: scored.slice(0, 5).map((x) => x.a.id) };
  return { status: "matched", app: scored[0]!.a, candidates: scored.slice(0, 5).map((x) => x.a.id) };
}

// ───────────────────────── Sync ─────────────────────────

export interface SyncResult {
  seen: number;
  relevant: number;
  classified: number;
  matched: number;
  updates: string[];
}

export async function sync(db: Db, userId: string, opts: { source?: MailSourceFactory; maxClassify?: number } = {}): Promise<SyncResult> {
  const [g] = await db.select().from(gmailIntegrations).where(eq(gmailIntegrations.userId, userId));
  if (!g || !g.appPasswordEnc) return { seen: 0, relevant: 0, classified: 0, matched: 0, updates: [] };
  const appPassword = decrypt(g.appPasswordEnc, aad(userId));
  const [vRaw, uRaw] = (g.historyId ?? ":0").split(":");
  const cursor = { uidValidity: vRaw || null, lastUid: Number(uRaw) || 0 };

  let src: MailSource;
  try {
    src = await (opts.source ?? imapSource)({ email: g.googleEmail, appPassword });
  } catch (err) {
    const msg = err instanceof AppError ? err.userMessage : String(err);
    await db.update(gmailIntegrations).set({ status: err instanceof AppError && err.code === "gmail_auth" ? "revoked" : "error", lastError: msg.slice(0, 300), updatedAt: new Date() }).where(eq(gmailIntegrations.id, g.id));
    throw err;
  }

  const res: SyncResult = { seen: 0, relevant: 0, classified: 0, matched: 0, updates: [] };
  try {
    const since = new Date(Date.now() - 21 * 86_400_000);
    const { uidValidity, headers } = await src.list(cursor, since, 300);
    res.seen = headers.length;

    const apps = (await db
      .select({ id: applications.id, status: applications.status, employerKey: applications.employerKey, company: jobs.companyName, title: jobs.title, jobId: jobs.id, dedupeKey: jobs.dedupeKey })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.userId, userId), ne(applications.status, "withdrawn"), gte(applications.createdAt, new Date(Date.now() - 180 * 86_400_000))))) as AppRow[];

    let budget = opts.maxClassify ?? 40;
    let maxUid = cursor.uidValidity === uidValidity ? cursor.lastUid : 0;
    for (const h of headers) {
      const msgKey = keyedHash(h.messageId, "gmail-msg");
      const [done] = await db.select({ id: processedEmails.id }).from(processedEmails).where(and(eq(processedEmails.userId, userId), eq(processedEmails.gmailMessageId, msgKey)));
      if (done) {
        maxUid = Math.max(maxUid, h.uid);
        continue;
      }
      if (!relevant(h, apps)) {
        maxUid = Math.max(maxUid, h.uid);
        continue;
      }
      res.relevant++;
      if (budget <= 0) break; // keep the cursor here; the rest is read next run
      budget--;

      const text = await src.text(h.uid);
      const { data, decisionId } = await structured<AiEmail>({
        db,
        userId,
        stage: "email_classification",
        agent: "email_tracking",
        inputSummary: `${h.from.address} · ${h.subject.slice(0, 80)}`,
        system: SYSTEM,
        user: `From: ${h.from.name} <${h.from.address}>\nDate: ${h.date.toISOString()}\nSubject: ${h.subject}\n\n${text}`,
        schemaName: "email_classification",
        schema: SCHEMA,
        maxOutputTokens: 1200,
        outcome: (d) => d.classification,
      });
      res.classified++;
      const m = data.classification === "other" ? { status: "unmatched" as const, candidates: [] as string[] } : matchApp(apps, h, data);
      const times = data.times.filter((t) => !Number.isNaN(Date.parse(t))).slice(0, 6);
      const [row] = await db
        .insert(processedEmails)
        .values({
          userId,
          gmailMessageId: msgKey,
          fromAddress: h.from.address.slice(0, 200),
          fromDomain: (h.from.address.split("@")[1] ?? "").slice(0, 120),
          subject: h.subject.slice(0, 300),
          receivedAt: h.date,
          classification: data.classification,
          matchStatus: m.status,
          matchedApplicationId: m.app?.id ?? null,
          candidateApplicationIds: m.candidates,
          confidence: Math.max(0, Math.min(1, data.confidence)).toFixed(3),
          aiDecisionId: decisionId,
          summary: data.summary.slice(0, 400),
          employerName: data.employer?.slice(0, 150) ?? null,
          jobTitle: data.jobTitle?.slice(0, 200) ?? null,
          proposedTimes: times,
          actionNeeded: data.actionNeeded,
        })
        .onConflictDoNothing()
        .returning();
      maxUid = Math.max(maxUid, h.uid);
      if (row && m.app) {
        res.matched++;
        const u = await applyEffect(db, userId, m.app, row);
        if (u) res.updates.push(u);
      }
    }
    await db.update(gmailIntegrations).set({ historyId: `${uidValidity}:${maxUid}`, lastSyncAt: new Date(), status: "connected", lastError: null, updatedAt: new Date() }).where(eq(gmailIntegrations.id, g.id));
  } finally {
    await src.close();
  }
  return res;
}

const SENT = ["submitted_unverified", "confirmed_by_email", "interview", "rejected", "closed"];

async function applyEffect(db: Db, userId: string, a: AppRow, e: typeof processedEmails.$inferSelect) {
  const now = new Date();
  const ev = (message: string, kind: "evidence" | "status_change" = "status_change") =>
    db.insert(applicationEvents).values({ userId, applicationId: a.id, kind, stage: "email", message, details: { processedEmailId: e.id } });
  const when = e.receivedAt ?? now;
  switch (e.classification) {
    case "application_receipt": {
      // A receipt also proves an application the user submitted themselves.
      await db.insert(submissionLedger).values({ userId, jobDedupeKey: a.dedupeKey, employerKey: a.employerKey, applicationId: a.id, state: "submitted" }).onConflictDoUpdate({ target: [submissionLedger.userId, submissionLedger.jobDedupeKey], set: { state: "submitted", updatedAt: now } });
      await db.insert(submissionEvidence).values({ userId, applicationId: a.id, kind: "email_receipt", level: "email", summary: e.summary ?? "Receipt email", processedEmailId: e.id, capturedAt: when });
      if (!["interview", "rejected", "closed"].includes(a.status)) {
        await db.update(applications).set({ status: "confirmed_by_email", emailConfirmedAt: when, submittedAt: sql`coalesce(${applications.submittedAt}, ${when})`, statusReason: null, updatedAt: now }).where(eq(applications.id, a.id));
      }
      await ev(`Confirmed by email from ${e.fromDomain}: ${e.summary}`, "evidence");
      return `${a.company}: confirmed by email`;
    }
    case "interview_invitation":
      await db.update(applications).set({ status: "interview", statusReason: e.summary, updatedAt: now }).where(eq(applications.id, a.id));
      await ev(`Interview invitation: ${e.summary}`);
      return `${a.company}: interview invitation`;
    case "assessment":
      await db.update(applications).set({ statusReason: `Assessment requested: ${e.summary}`, updatedAt: now }).where(eq(applications.id, a.id));
      await ev(`Assessment requested: ${e.summary}`);
      return `${a.company}: assessment requested`;
    case "rejection":
      await db.update(applications).set({ status: "rejected", statusReason: e.summary, updatedAt: now }).where(eq(applications.id, a.id));
      await ev(`Not progressing: ${e.summary}`);
      return `${a.company}: not progressing`;
    case "offer":
      await db.update(applications).set({ statusReason: `Offer: ${e.summary}`, updatedAt: now }).where(eq(applications.id, a.id));
      await ev(`Offer received: ${e.summary}`);
      return `${a.company}: offer`;
    case "status_update":
      if (!SENT.includes(a.status)) break;
      await ev(`Update: ${e.summary}`);
      return null;
  }
  return null;
}

// ───────────────────────── Reading ─────────────────────────

export async function recentJobEmails(db: Executor, userId: string, limit = 50) {
  return db
    .select({ e: processedEmails, company: jobs.companyName, title: jobs.title })
    .from(processedEmails)
    .leftJoin(applications, eq(applications.id, processedEmails.matchedApplicationId))
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(processedEmails.userId, userId), ne(processedEmails.classification, "other")))
    .orderBy(desc(processedEmails.receivedAt))
    .limit(limit);
}

export async function connectedUserIds(db: Executor) {
  const rows = await db.select({ userId: gmailIntegrations.userId }).from(gmailIntegrations).where(inArray(gmailIntegrations.status, ["connected", "error"]));
  return rows.map((r) => r.userId);
}
