import { sql } from "drizzle-orm";
import type { Database } from "@careerflow/db";
import type { queue } from "@careerflow/core";

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
export const systemSchedules = [{ kind: "maintenance.cleanup", intervalMinutes: 60 }];
