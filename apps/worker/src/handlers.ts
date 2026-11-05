import { sql } from "drizzle-orm";
import type { Database } from "@careerflow/db";
import { ai, discovery, matching, queue } from "@careerflow/core";
import { applicantProfiles } from "@careerflow/db";

export interface HandlerContext {
  db: Database;
  task: queue.TaskRow;
  signal: AbortSignal;
  /** Persist resumable progress. Set `irreversible: true` right before a final submit. */
  checkpoint(data: Record<string, unknown>): Promise<void>;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export class NonRetryableError extends Error {}

export type Handler = (ctx: HandlerContext) => Promise<unknown>;

/** Score in batches until nothing is left or the task's time budget is used up. */
async function evaluateUntilDone(db: Database, userId: string, opts: { staleBefore?: Date }, deadline: number) {
  const limit = Number(process.env.MAX_EVALUATIONS_PER_RUN ?? 40);
  const total = { evaluated: 0, recommended: 0, rejected: 0, review: 0, skipped: 0, more: false };
  for (;;) {
    const r = await matching.evaluateJobsForUser(db, userId, { ...opts, limit });
    for (const k of ["evaluated", "recommended", "rejected", "review", "skipped"] as const) total[k] += r[k];
    // Stop when the batch wasn't full, or when nothing could be saved (avoid spinning on failures).
    if (r.evaluated < limit || r.recommended + r.rejected + r.review === 0) return total;
    if (Date.now() > deadline) return { ...total, more: true };
  }
}

/**
 * Handlers registered here are the only task kinds this worker claims.
 * Kinds without a handler stay queued (visible in diagnostics) until a worker
 * that supports them is deployed — work is never silently dropped.
 */
export const handlers: Record<string, Handler> = {
  /** Fan out: one task per enabled job board. */
  "discovery.run_all": async ({ db, task }) => {
    const ids = await discovery.enabledSourceIds(db);
    for (const sourceId of ids) {
      await queue.enqueue(db, { kind: "discovery.run_source", payload: { sourceId, trigger: task.payload.trigger ?? "scheduled" }, dedupeKey: `discovery:${sourceId}`, timeoutSeconds: 900 });
    }
    return { sources: ids.length };
  },

  "discovery.run_source": async ({ db, task }) => {
    const r = await discovery.runSource(db, String(task.payload.sourceId), (task.payload.trigger as "scheduled" | "manual" | "reindex") ?? "scheduled");
    if (r.new || r.updated) await queue.enqueue(db, { kind: "matching.run_all", dedupeKey: "matching:all", runAt: new Date(Date.now() + 60_000) });
    return r;
  },

  /** Evaluate new/changed jobs for every user with a usable profile. */
  "matching.run_all": async ({ db, task }) => {
    if (!ai.aiConfigured()) return { skipped: "AI not configured" };
    const deadline = Date.now() + Math.max(60, task.timeoutSeconds - 90) * 1000;
    const users = await db.select({ id: applicantProfiles.userId, titles: applicantProfiles.preferredTitles }).from(applicantProfiles);
    const out: Record<string, unknown> = {};
    // One user's problem (e.g. unreadable data) must not stop matching for everyone else.
    for (const u of users) {
      if (!u.titles.length) continue;
      try {
        out[u.id] = await evaluateUntilDone(db, u.id, {}, deadline);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/rate-limit|no credit|API key/i.test(msg)) throw err; // account-wide: retry the whole run later
        out[u.id] = { error: msg.slice(0, 200) };
      }
    }
    return out;
  },

  "matching.run_user": async ({ db, task }) => {
    const userId = String(task.payload.userId);
    const staleBefore = typeof task.payload.staleBefore === "string" ? new Date(task.payload.staleBefore) : undefined;
    const deadline = Date.now() + Math.max(60, task.timeoutSeconds - 90) * 1000;
    const r = await evaluateUntilDone(db, userId, { staleBefore }, deadline);
    if (r.more) {
      // Out of time but jobs remain: continue in a fresh task.
      await queue.enqueue(db, { kind: "matching.run_user", userId, payload: task.payload, timeoutSeconds: task.timeoutSeconds });
    }
    return r;
  },

  "system.ping": async () => ({ pong: new Date().toISOString() }),

  "maintenance.cleanup": async ({ db }) => {
    const r1 = await db.execute(sql`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
    const r2 = await db.execute(sql`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`);
    const r3 = await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
    const r4 = await db.execute(sql`DELETE FROM tasks WHERE status IN ('succeeded','cancelled') AND finished_at < now() - interval '30 days'`);
    return { sessions: r1.rowCount, resetTokens: r2.rowCount, rateLimits: r3.rowCount, oldTasks: r4.rowCount };
  },
};

/** System schedules ensured at startup. Per-user schedules (discovery, Gmail sync) arrive with their phases. */
export const systemSchedules = [
  { kind: "maintenance.cleanup", intervalMinutes: 60 },
  { kind: "discovery.run_all", intervalMinutes: Number(process.env.DISCOVERY_INTERVAL_MINUTES ?? 360) },
  { kind: "autopilot.run", intervalMinutes: Number(process.env.AUTOPILOT_INTERVAL_MINUTES ?? 60) },
];
