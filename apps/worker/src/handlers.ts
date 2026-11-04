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
  "matching.run_all": async ({ db }) => {
    if (!ai.aiConfigured()) return { skipped: "AI not configured" };
    const users = await db.select({ id: applicantProfiles.userId, titles: applicantProfiles.preferredTitles }).from(applicantProfiles);
    const out: Record<string, unknown> = {};
    for (const u of users) {
      if (!u.titles.length) continue;
      out[u.id] = await matching.evaluateJobsForUser(db, u.id);
    }
    return out;
  },

  "matching.run_user": async ({ db, task }) => matching.evaluateJobsForUser(db, String(task.payload.userId)),

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
];
