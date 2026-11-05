/**
 * Learning from the user's decisions and real outcomes:
 * "Not interested" (with a reason), approvals, cancellations, submissions, interviews,
 * rejections and offers. Matching uses them as examples, and an employer the user ruled
 * out is never recommended again.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { employerAssessments, jobEvaluations, jobFeedback, jobs } from "@careerflow/db";
import { AppError, notFound } from "../errors";
import type { Db, Executor } from "../types";
import * as queue from "./queue";

export type Signal = "not_interested" | "approved" | "cancelled" | "applied" | "interview" | "rejected" | "offer";

export const REASONS: Record<string, string> = {
  role: "Not the right kind of role",
  seniority: "Wrong seniority",
  employer: "Not interested in this employer",
  employer_type: "Wrong type of company (e.g. subcontractor)",
  location: "Location",
  salary: "Pay / package",
  other: "Other",
};

export async function record(db: Executor, userId: string, jobId: string, signal: Signal, reason?: string | null) {
  await db
    .insert(jobFeedback)
    .values({ userId, jobId, signal, reason: reason?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: [jobFeedback.userId, jobFeedback.jobId, jobFeedback.signal], set: { reason: reason?.slice(0, 300) ?? null, createdAt: new Date() } });
}

/** Re-score the current recommendations with what was just learned (batched: at most one run per 10 minutes). */
async function scheduleRelearn(db: Executor, userId: string) {
  await queue.enqueue(db, {
    kind: "matching.run_user",
    userId,
    payload: { userId, staleBefore: new Date(Date.now() + 10 * 60_000).toISOString(), rescoreDecisions: ["recommended", "needs_review"] },
    dedupeKey: `learn:${userId}`,
    runAt: new Date(Date.now() + 10 * 60_000),
    timeoutSeconds: 900,
  });
}

export async function notInterested(db: Db, userId: string, jobId: string, reasonKey: string, note?: string | null) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw notFound("Job");
  if (!REASONS[reasonKey]) throw new AppError("invalid_reason", "Pick a reason.");
  const reason = `${reasonKey}${note?.trim() ? `: ${note.trim().slice(0, 200)}` : ""}`;
  await record(db, userId, jobId, "not_interested", reason);
  // The user's decision replaces the current score for this job right away.
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(jobEvaluations).where(and(eq(jobEvaluations.userId, userId), eq(jobEvaluations.jobId, jobId), isNull(jobEvaluations.supersededAt)));
    await tx.update(jobEvaluations).set({ supersededAt: new Date() }).where(and(eq(jobEvaluations.userId, userId), eq(jobEvaluations.jobId, jobId), isNull(jobEvaluations.supersededAt)));
    await tx.insert(jobEvaluations).values({
      userId,
      jobId,
      profileVersion: cur?.profileVersion ?? 1,
      jobDescriptionHash: job.descriptionHash,
      score: 0,
      decision: "rejected",
      eligibility: cur?.eligibility ?? "uncertain",
      breakdown: [],
      summary: `You marked this as not interested — ${REASONS[reasonKey]!.toLowerCase()}.`,
      rejectionReasons: [`Your decision: ${REASONS[reasonKey]}`],
      method: "rule",
    });
  });
  await scheduleRelearn(db, userId);
}

export async function undoNotInterested(db: Db, userId: string, jobId: string) {
  await db.delete(jobFeedback).where(and(eq(jobFeedback.userId, userId), eq(jobFeedback.jobId, jobId), eq(jobFeedback.signal, "not_interested")));
  await db.update(jobEvaluations).set({ supersededAt: new Date() }).where(and(eq(jobEvaluations.userId, userId), eq(jobEvaluations.jobId, jobId), isNull(jobEvaluations.supersededAt)));
  await queue.enqueue(db, { kind: "matching.run_user", userId, payload: { userId }, dedupeKey: `matching:user:${userId}`, timeoutSeconds: 900 });
}

/** Employers the user said they're not interested in (by employer key). */
export async function ruledOutEmployers(db: Executor, userId: string) {
  const rows = await db
    .select({ key: jobs.employerKey })
    .from(jobFeedback)
    .innerJoin(jobs, eq(jobs.id, jobFeedback.jobId))
    .where(and(eq(jobFeedback.userId, userId), eq(jobFeedback.signal, "not_interested"), sql`${jobFeedback.reason} LIKE 'employer%'`));
  return new Set(rows.map((r) => r.key));
}

/** A compact summary of past decisions for the matching AI (most recent first). */
export async function learnedContext(db: Executor, userId: string) {
  const rows = await db
    .select({ signal: jobFeedback.signal, reason: jobFeedback.reason, title: jobs.title, company: jobs.companyName, type: employerAssessments.employerType })
    .from(jobFeedback)
    .innerJoin(jobs, eq(jobs.id, jobFeedback.jobId))
    .leftJoin(employerAssessments, eq(employerAssessments.employerKey, jobs.employerKey))
    .where(eq(jobFeedback.userId, userId))
    .orderBy(desc(jobFeedback.createdAt))
    .limit(60);
  if (!rows.length) return null;
  const line = (r: (typeof rows)[number]) => `${r.title} at ${r.company}${r.type && r.type !== "unknown" ? ` (${r.type.replace(/_/g, " ")})` : ""}${r.reason ? ` — ${REASONS[r.reason.split(":")[0]!] ?? r.reason}${r.reason.includes(":") ? `: ${r.reason.split(":").slice(1).join(":").trim()}` : ""}` : ""}`;
  const pos = rows.filter((r) => ["approved", "applied", "interview", "offer"].includes(r.signal)).slice(0, 12);
  const neg = rows.filter((r) => ["not_interested", "cancelled"].includes(r.signal)).slice(0, 12);
  const outcomes = rows.filter((r) => ["interview", "offer", "rejected"].includes(r.signal)).slice(0, 10);
  return [
    pos.length ? `Jobs the candidate chose to apply for:\n${pos.map((r) => `- ${line(r)}`).join("\n")}` : "",
    neg.length ? `Jobs the candidate turned down (and why):\n${neg.map((r) => `- ${line(r)}`).join("\n")}` : "",
    outcomes.length ? `Real outcomes so far:\n${outcomes.map((r) => `- ${r.signal.toUpperCase()}: ${r.title} at ${r.company}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function summary(db: Executor, userId: string) {
  const rows = await db.select({ signal: jobFeedback.signal, n: sql<number>`count(*)::int` }).from(jobFeedback).where(eq(jobFeedback.userId, userId)).groupBy(jobFeedback.signal);
  const get = (s: Signal) => rows.find((r) => r.signal === s)?.n ?? 0;
  return { notInterested: get("not_interested"), approved: get("approved") + get("applied"), outcomes: get("interview") + get("rejected") + get("offer"), total: rows.reduce((a, r) => a + r.n, 0) };
}

export async function forJobs(db: Executor, userId: string, jobIds: string[]) {
  if (!jobIds.length) return new Map<string, string>();
  const rows = await db.select({ jobId: jobFeedback.jobId, reason: jobFeedback.reason }).from(jobFeedback).where(and(eq(jobFeedback.userId, userId), eq(jobFeedback.signal, "not_interested"), inArray(jobFeedback.jobId, jobIds)));
  return new Map(rows.map((r) => [r.jobId, r.reason ?? ""]));
}
