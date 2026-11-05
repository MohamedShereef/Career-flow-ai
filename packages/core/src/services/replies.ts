/**
 * Replies to employer emails (interview scheduling, assessments, offers).
 * CareerFlow drafts; the user edits and presses Send. Nothing is sent otherwise.
 * Sent from the user's own Gmail (SMTP with the same app password), in the same thread.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { applicationEvents, applications, emailDrafts, gmailIntegrations, jobs, processedEmails } from "@careerflow/db";
import { js, structured } from "../ai";
import { decrypt, encrypt } from "../crypto";
import { AppError, notFound } from "../errors";
import type { Db, Executor } from "../types";
import { audit } from "./audit";
import * as profile from "./profile";
import { getSettings } from "./settings";

const aad = (userId: string, id: string) => `draft:${userId}:${id}`;
const gmailAad = (userId: string) => `gmail:${userId}`;

export interface OutgoingMail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
}
export type MailSender = (creds: { email: string; appPassword: string }, mail: OutgoingMail) => Promise<{ messageId: string }>;

export const gmailSmtp: MailSender = async ({ email, appPassword }, mail) => {
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: email, pass: appPassword } });
  try {
    const info = await t.sendMail({
      from: { name: mail.from.name, address: mail.from.address },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.references ?? mail.inReplyTo } : {}),
    });
    return { messageId: info.messageId };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/535|auth|credential|Username and Password/i.test(msg)) throw new AppError("gmail_auth", "Google rejected the app password when sending. Reconnect Gmail in Settings → Integrations.");
    throw new AppError("send_failed", `Gmail didn't accept the email: ${msg.slice(0, 160)}`);
  } finally {
    t.close();
  }
};

const SCHEMA = js.obj({ body: js.str("The email body only: greeting, 2–5 short sentences, sign-off with the candidate's name") });

const SYSTEM = `You write a short reply from a job candidate to an employer's email about their application.
Rules:
- Reply only to what the email asks (confirming an interview time, sharing availability, acknowledging an assessment or offer).
- If a chosen time is given, accept exactly that time, restated clearly with its time zone.
- If the employer asks for availability and no time is chosen, offer the candidate's availability exactly as written. If none is provided, say you're flexible and ask them to propose a time.
- For an offer: thank them and say you'll review it and reply shortly. Do not accept, negotiate or mention salary.
- Never invent facts: no new dates, numbers, qualifications, salary, notice period, references or commitments that aren't given.
- Reply in the same language as the employer's email. Professional and warm, under 120 words. No subject line.
- Sign off with the candidate's name (and phone if given).`;

function replySubject(subject: string | null) {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s || "Your email"}`;
}

export async function draftReply(db: Db, userId: string, processedEmailId: string, opts: { emailText?: string; chosenTime?: string | null } = {}) {
  const [e] = await db.select().from(processedEmails).where(and(eq(processedEmails.id, processedEmailId), eq(processedEmails.userId, userId)));
  if (!e) throw notFound("Email");
  const to = e.replyTo || e.fromAddress;
  if (!to) throw new AppError("no_recipient", "This email has no address to reply to.");
  const [p, s] = await Promise.all([profile.getProfile(db, userId), getSettings(db, userId)]);
  const [ctx] = e.matchedApplicationId
    ? await db.select({ title: jobs.title, company: jobs.companyName }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(eq(applications.id, e.matchedApplicationId))
    : [];
  const times = e.proposedTimes ?? [];
  const chosen = opts.chosenTime !== undefined ? opts.chosenTime : e.classification === "interview_invitation" && times.length === 1 ? times[0]! : null;
  const fmt = (t: string) => new Date(t).toLocaleString("en-GB", { timeZone: s.timezone, dateStyle: "full", timeStyle: "short" }) + ` (${s.timezone})`;

  const { data, decisionId } = await structured<{ body: string }>({
    db,
    userId,
    stage: "reply_draft",
    agent: "email_tracking",
    inputSummary: `${e.classification} from ${e.fromDomain}`,
    system: SYSTEM,
    user: [
      `EMPLOYER EMAIL — from: ${e.fromAddress}; subject: ${e.subject ?? ""}`,
      `What it says: ${e.summary ?? ""}`,
      opts.emailText ? `Full text:\n"""\n${opts.emailText.slice(0, 5000)}\n"""` : "",
      `Times offered in the email: ${times.length ? times.map(fmt).join(" | ") : "none"}`,
      `Chosen time: ${chosen ? fmt(chosen) : "none"}`,
      `Candidate: ${p.fullName ?? ""}${p.phone ? `, phone ${p.phone}` : ""}`,
      `Candidate availability: ${s.interviewAvailability ?? "not provided"}`,
      ctx ? `Application: ${ctx.title} at ${ctx.company}` : "",
    ].filter(Boolean).join("\n"),
    schemaName: "reply_draft",
    schema: SCHEMA,
    maxOutputTokens: 900,
    outcome: () => "drafted",
  });

  return db.transaction(async (tx) => {
    await tx.update(emailDrafts).set({ status: "discarded", updatedAt: new Date() }).where(and(eq(emailDrafts.processedEmailId, e.id), eq(emailDrafts.status, "draft")));
    const id = crypto.randomUUID();
    const [d] = await tx
      .insert(emailDrafts)
      .values({ id, userId, processedEmailId: e.id, applicationId: e.matchedApplicationId, toAddress: to, subject: replySubject(e.subject), bodyEnc: encrypt(data.body.trim(), aad(userId, id)), chosenTime: chosen, aiDecisionId: decisionId })
      .returning();
    return d!;
  });
}

export async function getForEmail(db: Executor, userId: string, processedEmailId: string) {
  const [e] = await db.select().from(processedEmails).where(and(eq(processedEmails.id, processedEmailId), eq(processedEmails.userId, userId)));
  if (!e) throw notFound("Email");
  const [d] = await db.select().from(emailDrafts).where(eq(emailDrafts.processedEmailId, e.id)).orderBy(desc(emailDrafts.createdAt)).limit(1);
  const [app] = e.matchedApplicationId
    ? await db.select({ id: applications.id, title: jobs.title, company: jobs.companyName }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(eq(applications.id, e.matchedApplicationId))
    : [];
  return { email: e, application: app ?? null, draft: d ? { ...d, body: decrypt(d.bodyEnc, aad(userId, d.id)) } : null };
}

export async function updateDraft(db: Db, userId: string, draftId: string, body: string) {
  const text = body.trim();
  if (text.length < 5 || text.length > 5000) throw new AppError("invalid_body", "Write the reply (up to 5,000 characters).");
  const r = await db
    .update(emailDrafts)
    .set({ bodyEnc: encrypt(text, aad(userId, draftId)), error: null, updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId), eq(emailDrafts.status, "draft")))
    .returning({ id: emailDrafts.id });
  if (!r.length) throw new AppError("not_editable", "This reply was already sent or discarded.");
}

/** Send the user's approved reply. Exactly once: the status flips to "sending" atomically first. */
export async function sendDraft(db: Db, userId: string, draftId: string, body: string | null, sender: MailSender = gmailSmtp) {
  if (body !== null) await updateDraft(db, userId, draftId, body);
  const [g] = await db.select().from(gmailIntegrations).where(eq(gmailIntegrations.userId, userId));
  if (!g?.appPasswordEnc) throw new AppError("gmail_not_connected", "Connect Gmail in Settings → Integrations first.");
  const [d] = await db
    .update(emailDrafts)
    .set({ status: "sending", updatedAt: new Date() })
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId), eq(emailDrafts.status, "draft")))
    .returning();
  if (!d) throw new AppError("not_sendable", "This reply was already sent or discarded.");
  const [e] = await db.select().from(processedEmails).where(eq(processedEmails.id, d.processedEmailId));
  const p = await profile.getProfile(db, userId);
  const text = decrypt(d.bodyEnc, aad(userId, d.id));
  try {
    await sender({ email: g.googleEmail, appPassword: decrypt(g.appPasswordEnc, gmailAad(userId)) }, { from: { name: p.fullName ?? g.googleEmail, address: g.googleEmail }, to: d.toAddress, subject: d.subject, text, inReplyTo: e?.rfcMessageId ?? null });
  } catch (err) {
    const msg = err instanceof AppError ? err.userMessage : String(err).slice(0, 200);
    await db.update(emailDrafts).set({ status: "draft", error: msg, updatedAt: new Date() }).where(eq(emailDrafts.id, d.id));
    throw err;
  }
  const now = new Date();
  await db.update(emailDrafts).set({ status: "sent", sentAt: now, error: null, updatedAt: now }).where(eq(emailDrafts.id, d.id));
  await db.update(processedEmails).set({ actionNeeded: false }).where(eq(processedEmails.id, d.processedEmailId));
  if (d.applicationId) {
    await db.insert(applicationEvents).values({
      userId,
      applicationId: d.applicationId,
      kind: "user_action",
      stage: "email",
      message: `You replied to ${d.toAddress}${d.chosenTime ? ` confirming ${new Date(d.chosenTime).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" })}` : ""}.`,
      details: { draftId: d.id },
    });
    if (d.chosenTime) await db.update(applications).set({ statusReason: `Interview confirmed for ${new Date(d.chosenTime).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "full", timeStyle: "short" })} (Riyadh)`, updatedAt: now }).where(eq(applications.id, d.applicationId));
  }
  await audit(db, { userId, actor: "user", action: "email.reply_sent", entityType: "email_draft", entityId: d.id, metadata: { to: d.toAddress } });
}

export async function discardDraft(db: Db, userId: string, draftId: string) {
  await db.update(emailDrafts).set({ status: "discarded", updatedAt: new Date() }).where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.userId, userId), eq(emailDrafts.status, "draft")));
}

/** "Add to Google Calendar" link — no calendar access needed. */
export function calendarLink(title: string, startIso: string, minutes = 60, details = "") {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + minutes * 60_000);
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(start)}/${f(end)}&details=${encodeURIComponent(details)}`;
}

export async function openReplyCount(db: Executor, userId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(emailDrafts).where(and(eq(emailDrafts.userId, userId), eq(emailDrafts.status, "draft")));
  return r?.n ?? 0;
}

export async function setAvailability(db: Db, userId: string, text: string) {
  const { automationSettings } = await import("@careerflow/db");
  await getSettings(db, userId);
  await db.update(automationSettings).set({ interviewAvailability: text.trim().slice(0, 300) || null, updatedAt: new Date() }).where(eq(automationSettings.userId, userId));
}
