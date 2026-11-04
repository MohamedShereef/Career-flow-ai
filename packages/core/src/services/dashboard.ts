import { and, eq, gt, sql } from "drizzle-orm";
import { aiDecisions, applications, errorRecords, jobEvaluations, jobSources, workerHeartbeats } from "@careerflow/db";
import type { Executor } from "../types";
import { openQuestionCount } from "./answers";

/** Every number on Home comes from these queries — no placeholders. */
export async function homeStats(db: Executor, userId: string) {
  const byStatus = await db
    .select({ status: applications.status, n: sql<number>`count(*)::int` })
    .from(applications)
    .where(eq(applications.userId, userId))
    .groupBy(applications.status);
  const count = (...s: string[]) => byStatus.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);

  const [newJobs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobEvaluations)
    .where(
      and(
        eq(jobEvaluations.userId, userId),
        eq(jobEvaluations.decision, "recommended"),
        sql`${jobEvaluations.supersededAt} IS NULL`,
        gt(jobEvaluations.createdAt, sql`now() - interval '7 days'`),
      ),
    );

  const problems = await db
    .select({ rootCauseKey: errorRecords.rootCauseKey, category: errorRecords.category, message: sql<string>`max(${errorRecords.userMessage})`, n: sql<number>`count(*)::int` })
    .from(errorRecords)
    .where(and(eq(errorRecords.userId, userId), sql`${errorRecords.resolvedAt} IS NULL`))
    .groupBy(errorRecords.rootCauseKey, errorRecords.category)
    .orderBy(sql`count(*) desc`)
    .limit(5);

  const attempted = count("submitted_unverified", "confirmed_by_email", "interview", "rejected", "failed");
  const succeeded = count("submitted_unverified", "confirmed_by_email", "interview", "rejected");

  return {
    confirmedByEmail: count("confirmed_by_email", "interview"),
    submittedAwaitingConfirmation: count("submitted_unverified"),
    awaitingApproval: count("awaiting_approval"),
    needsUserAction: count("needs_user_action"),
    openQuestions: await openQuestionCount(db, userId),
    newRelevantJobs: newJobs?.n ?? 0,
    attempted,
    successRate: attempted ? Math.round((succeeded / attempted) * 100) : null,
    problems,
  };
}

export async function systemHealth(db: Executor) {
  const started = Date.now();
  await db.execute(sql`select 1`);
  const dbLatencyMs = Date.now() - started;
  const workers = await db.select().from(workerHeartbeats).orderBy(sql`${workerHeartbeats.lastSeenAt} desc`).limit(10);
  const sources = await db
    .select({ health: jobSources.health, n: sql<number>`count(*)::int` })
    .from(jobSources)
    .where(eq(jobSources.enabled, true))
    .groupBy(jobSources.health);
  const [queue] = await db.execute<{ queued: number; running: number; blocked: number; dead_24h: number }>(sql`
    select count(*) filter (where status='queued')::int as queued,
           count(*) filter (where status='running')::int as running,
           count(*) filter (where status='blocked')::int as blocked,
           count(*) filter (where status='dead' and finished_at > now() - interval '24 hours')::int as dead_24h
    from tasks`).then((r) => r.rows);
  const now = Date.now();
  // The key being present isn't enough: report what the last real AI call said.
  const [lastAi] = await db.select({ status: aiDecisions.status, error: aiDecisions.error, at: aiDecisions.createdAt }).from(aiDecisions).where(sql`${aiDecisions.status} <> 'unavailable'`).orderBy(sql`${aiDecisions.createdAt} desc`).limit(1);
  const aiState = !process.env.OPENAI_API_KEY ? "missing" : lastAi?.status === "error" && /ai_auth|rejected/i.test(lastAi.error ?? "") ? "rejected" : lastAi?.status === "error" && /rate|credit/i.test(lastAi.error ?? "") ? "no_credit" : lastAi?.status === "ok" ? "working" : "untested";
  return {
    database: { ok: true, latencyMs: dbLatencyMs },
    workers: workers.map((w) => ({ ...w, online: now - w.lastSeenAt.getTime() < 90_000 })),
    workerOnline: workers.some((w) => now - w.lastSeenAt.getTime() < 90_000),
    sources,
    queue: queue ?? { queued: 0, running: 0, blocked: 0, dead_24h: 0 },
    ai: { configured: !!process.env.OPENAI_API_KEY, state: aiState, lastError: lastAi?.status === "error" ? lastAi.error : null },
  };
}
