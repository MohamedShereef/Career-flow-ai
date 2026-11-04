/**
 * Durable Postgres task queue.
 *
 * - Claiming uses `FOR UPDATE SKIP LOCKED`, so concurrent workers never run
 *   the same task.
 * - Every write after claiming is fenced on `locked_by`, so a worker whose
 *   lease was reclaimed cannot overwrite the new owner's state.
 * - Handlers persist checkpoints; a task resumes from its checkpoint after a
 *   crash or redeploy.
 * - A checkpoint with `irreversible: true` (set immediately before a final
 *   Submit click) prevents any automatic retry: an interrupted irreversible
 *   step becomes `blocked` and needs evidence review, never a blind resubmit.
 */
import { sql } from "drizzle-orm";
import { tasks } from "@careerflow/db";
import type { Executor } from "../types";

export type TaskRow = typeof tasks.$inferSelect;

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  userId?: string | null;
  runAt?: Date;
  priority?: number;
  dedupeKey?: string | null;
  maxAttempts?: number;
  timeoutSeconds?: number;
}

/** Returns the new task, or null when an identical pending task (same dedupeKey) exists. */
export async function enqueue(db: Executor, input: EnqueueInput): Promise<TaskRow | null> {
  const rows = await db
    .insert(tasks)
    .values({
      kind: input.kind,
      payload: input.payload ?? {},
      userId: input.userId ?? null,
      runAt: input.runAt ?? new Date(),
      priority: input.priority ?? 100,
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      timeoutSeconds: input.timeoutSeconds ?? 600,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

const toTask = (r: Record<string, unknown>): TaskRow => ({
  id: r.id as string,
  userId: (r.user_id as string) ?? null,
  kind: r.kind as string,
  payload: (r.payload as Record<string, unknown>) ?? {},
  status: r.status as TaskRow["status"],
  priority: Number(r.priority),
  runAt: new Date(r.run_at as string),
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  dedupeKey: (r.dedupe_key as string) ?? null,
  lockedBy: (r.locked_by as string) ?? null,
  lockedAt: r.locked_at ? new Date(r.locked_at as string) : null,
  heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at as string) : null,
  timeoutSeconds: Number(r.timeout_seconds),
  checkpoint: (r.checkpoint as Record<string, unknown>) ?? null,
  result: r.result ?? null,
  lastError: (r.last_error as string) ?? null,
  createdAt: new Date(r.created_at as string),
  finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
});

export async function claim(db: Executor, workerId: string, kinds?: string[]): Promise<TaskRow | null> {
  const kindFilter = kinds?.length ? sql`AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    UPDATE tasks SET status = 'running', locked_by = ${workerId}, locked_at = now(), heartbeat_at = now(),
                     attempts = attempts + 1
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'queued' AND run_at <= now() ${kindFilter}
      ORDER BY priority ASC, run_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return row ? toTask(row) : null;
}

/** Returns false when the lease was lost (task reclaimed or cancelled). */
export async function heartbeat(db: Executor, taskId: string, workerId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE tasks SET heartbeat_at = now()
    WHERE id = ${taskId} AND locked_by = ${workerId} AND status = 'running'
    RETURNING id`);
  return res.rows.length > 0;
}

export async function saveCheckpoint(
  db: Executor,
  taskId: string,
  workerId: string,
  checkpoint: Record<string, unknown>,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE tasks SET checkpoint = ${JSON.stringify(checkpoint)}::jsonb, heartbeat_at = now()
    WHERE id = ${taskId} AND locked_by = ${workerId} AND status = 'running'
    RETURNING id`);
  return res.rows.length > 0;
}

export async function complete(db: Executor, taskId: string, workerId: string, result?: unknown): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE tasks SET status = 'succeeded', result = ${result === undefined ? null : JSON.stringify(result)}::jsonb,
                     finished_at = now(), locked_by = NULL
    WHERE id = ${taskId} AND locked_by = ${workerId} AND status = 'running'
    RETURNING id`);
  return res.rows.length > 0;
}

/** Exponential backoff: 30s, 60s, 120s … capped at 1h. */
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

export async function fail(
  db: Executor,
  taskId: string,
  workerId: string,
  error: string,
  opts: { retryable?: boolean } = {},
): Promise<"retry" | "dead" | "blocked" | "lost"> {
  const retryable = opts.retryable ?? true;
  const res = await db.execute(sql`
    UPDATE tasks SET
      status = (CASE
        WHEN coalesce((checkpoint->>'irreversible')::boolean, false) THEN 'blocked'
        WHEN ${retryable} AND attempts < max_attempts THEN 'queued'
        ELSE 'dead' END)::task_status,
      run_at = CASE WHEN ${retryable} AND attempts < max_attempts
                    THEN now() + make_interval(secs => LEAST(3600, 30 * power(2, GREATEST(attempts - 1, 0))))
                    ELSE run_at END,
      last_error = ${error.slice(0, 4000)},
      locked_by = NULL,
      finished_at = CASE WHEN ${retryable} AND attempts < max_attempts
                          AND NOT coalesce((checkpoint->>'irreversible')::boolean, false) THEN NULL ELSE now() END
    WHERE id = ${taskId} AND locked_by = ${workerId} AND status = 'running'
    RETURNING status`);
  const status = (res.rows[0] as { status?: string } | undefined)?.status;
  if (!status) return "lost";
  return status === "queued" ? "retry" : (status as "dead" | "blocked");
}

/**
 * Recover tasks whose worker died (no heartbeat within `staleSeconds`) or that
 * exceeded their timeout. Irreversible tasks are blocked for human review.
 */
export async function reclaimStale(db: Executor, staleSeconds = 90) {
  const res = await db.execute(sql`
    UPDATE tasks SET
      status = (CASE
        WHEN coalesce((checkpoint->>'irreversible')::boolean, false) THEN 'blocked'
        WHEN attempts < max_attempts THEN 'queued'
        ELSE 'dead' END)::task_status,
      last_error = CASE
        WHEN coalesce((checkpoint->>'irreversible')::boolean, false)
          THEN 'Worker stopped during an irreversible step. Outcome must be verified before any retry.'
        ELSE 'Worker stopped responding; task was re-queued from its last checkpoint.' END,
      locked_by = NULL,
      run_at = now()
    WHERE status = 'running' AND (
      heartbeat_at < now() - make_interval(secs => ${staleSeconds}) OR
      locked_at < now() - make_interval(secs => timeout_seconds)
    )
    RETURNING id, status`);
  return res.rows as Array<{ id: string; status: string }>;
}

export async function cancelTask(db: Executor, taskId: string, userId?: string) {
  await db.execute(sql`
    UPDATE tasks SET status = 'cancelled', finished_at = now(), locked_by = NULL
    WHERE id = ${taskId} AND status IN ('queued','blocked') ${userId ? sql`AND user_id = ${userId}` : sql``}`);
}
