/**
 * Assisted apply (works today, before the browser automation ships):
 *  1. "Apply" opens the employer's official application page with the approved
 *     tailored CV and cover letter ready to upload.
 *  2. "I've submitted it" records the application in the permanent ledger so the
 *     agent never applies to the same job twice, and starts tracking it.
 */
import { and, desc, eq } from "drizzle-orm";
import { applicationEvents, applications, cvTailorings, jobs, submissionLedger } from "@careerflow/db";
import { sha256 } from "../crypto";
import { AppError, notFound } from "../errors";
import { employerKey } from "../normalize";
import type { Db } from "../types";
import { audit } from "./audit";

const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function cleanUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AppError("invalid_url", "Paste the full link to the job's application page (starting with https://).");
  }
  if (!/^https?:$/.test(u.protocol)) throw new AppError("invalid_url", "The link must start with https://.");
  return u.toString();
}

/** A job row for a posting the user found themselves (LinkedIn, referral, email). */
async function ensureManualJob(db: Db, t: typeof cvTailorings.$inferSelect, applyUrl: string) {
  const url = cleanUrl(applyUrl);
  const dedupeKey = sha256([employerKey(t.companyName), titleKey(t.jobTitle), ""].join("|"));
  const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey));
  if (existing) {
    if (existing.sourceId === null && existing.applyUrl !== url) {
      await db.update(jobs).set({ applyUrl: url, sourceUrl: url }).where(eq(jobs.id, existing.id));
    }
    return existing.id;
  }
  const [row] = await db
    .insert(jobs)
    .values({
      sourceId: null,
      externalId: `manual:${dedupeKey.slice(0, 24)}`,
      dedupeKey,
      title: t.jobTitle,
      companyName: t.companyName,
      employerKey: employerKey(t.companyName),
      description: t.jobDescription,
      descriptionHash: sha256(t.jobDescription),
      sourceUrl: url,
      applyUrl: url,
      raw: { origin: "user_pasted" },
    })
    .returning({ id: jobs.id });
  return row!.id;
}

export async function getForTailoring(db: Db, userId: string, tailoringId: string) {
  const [t] = await db.select().from(cvTailorings).where(and(eq(cvTailorings.id, tailoringId), eq(cvTailorings.userId, userId)));
  if (!t) throw notFound("Tailored CV");
  if (!t.jobId) return { tailoring: t, job: null, application: null, ledger: null };
  const [job] = await db.select().from(jobs).where(eq(jobs.id, t.jobId));
  const [application] = await db.select().from(applications).where(and(eq(applications.userId, userId), eq(applications.jobId, t.jobId)));
  const [ledger] = job ? await db.select().from(submissionLedger).where(and(eq(submissionLedger.userId, userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey))) : [];
  return { tailoring: t, job: job ?? null, application: application ?? null, ledger: ledger ?? null };
}

/** Step 1: link the approved CV to the job and return the employer's apply link. */
export async function prepare(db: Db, userId: string, tailoringId: string, pastedUrl?: string | null, opts: { opened?: boolean } = {}) {
  const [t] = await db.select().from(cvTailorings).where(and(eq(cvTailorings.id, tailoringId), eq(cvTailorings.userId, userId)));
  if (!t) throw notFound("Tailored CV");
  if (!t.approvedAt) throw new AppError("not_approved", "Approve this CV version first.");
  if (!t.cvDocumentId) throw new AppError("no_cv", "This tailored CV has no PDF yet. Tailor it again.");

  let jobId = t.jobId;
  if (!jobId) {
    if (!pastedUrl) throw new AppError("need_url", "Paste the link to the job's application page.");
    jobId = await ensureManualJob(db, t, pastedUrl);
    await db.update(cvTailorings).set({ jobId }).where(eq(cvTailorings.id, t.id));
  }
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw notFound("Job");

  const [already] = await db.select().from(submissionLedger).where(and(eq(submissionLedger.userId, userId), eq(submissionLedger.jobDedupeKey, job.dedupeKey)));
  if (already?.state === "submitted") throw new AppError("already_applied", `You already applied to this job on ${already.createdAt.toISOString().slice(0, 10)}.`);

  const [app] = await db
    .insert(applications)
    .values({ userId, jobId, employerKey: job.employerKey, status: "prepared", tailoredCvDocumentId: t.cvDocumentId, coverLetterDocumentId: t.coverLetterDocumentId, checkpoint: "opened_apply_page", checkpointData: { tailoringId: t.id } })
    .onConflictDoUpdate({
      target: [applications.userId, applications.jobId],
      set: { tailoredCvDocumentId: t.cvDocumentId, coverLetterDocumentId: t.coverLetterDocumentId, updatedAt: new Date() },
    })
    .returning();
  await db.insert(applicationEvents).values({ userId, applicationId: app!.id, kind: "user_action", stage: "prepare", message: opts.opened ? "You opened the employer's application page with the approved CV." : "Linked the approved CV to this job's application page." });
  return { applicationId: app!.id, applyUrl: job.applyUrl };
}

/** Step 2: the user confirms they submitted on the employer's site. */
export async function markSubmitted(db: Db, userId: string, applicationId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ a: applications, dedupeKey: jobs.dedupeKey })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
    if (!row) throw notFound("Application");
    const inserted = await tx
      .insert(submissionLedger)
      .values({ userId, jobDedupeKey: row.dedupeKey, employerKey: row.a.employerKey, applicationId, state: "submitted" })
      .onConflictDoNothing()
      .returning({ id: submissionLedger.id });
    if (!inserted.length) {
      const [l] = await tx.select().from(submissionLedger).where(and(eq(submissionLedger.userId, userId), eq(submissionLedger.jobDedupeKey, row.dedupeKey)));
      if (l?.state === "submitted") return { alreadyRecorded: true };
      await tx.update(submissionLedger).set({ state: "submitted", applicationId, updatedAt: new Date() }).where(eq(submissionLedger.id, l!.id));
    }
    const now = new Date();
    await tx.update(applications).set({ status: "submitted_unverified", submittedAt: now, checkpoint: "submitted_by_user", updatedAt: now }).where(eq(applications.id, applicationId));
    await tx.insert(applicationEvents).values({ userId, applicationId, kind: "status_change", stage: "submit", message: "You submitted this application on the employer's site. Waiting for a confirmation email." });
    await audit(tx, { userId, actor: "user", action: "application.submitted_by_user", entityType: "application", entityId: applicationId });
    return { alreadyRecorded: false };
  });
}

export async function listForUser(db: Db, userId: string) {
  return db
    .select({ a: applications, title: jobs.title, company: jobs.companyName, applyUrl: jobs.applyUrl })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.updatedAt))
    .limit(200);
}
