import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@careerflow/db";
import { queue } from "@careerflow/core";
import { NonRetryableError, type Handler, systemSchedules } from "./handlers";
import { log } from "./log";

export interface RunnerOptions {
  db: Database;
  handlers: Record<string, Handler>;
  workerId?: string;
  kind?: string;
  heartbeatMs?: number;
  idleMs?: number;
  staleSeconds?: number;
  version?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class Runner {
  readonly workerId: string;
  private stopping = new AbortController();
  private currentTask: queue.TaskRow | null = null;
  private stats = { succeeded: 0, failed: 0, retried: 0, blocked: 0 };
  private loopDone: Promise<void> | null = null;

  constructor(private opts: RunnerOptions) {
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  }

  private get db() {
    return this.opts.db;
  }

  async registerHeartbeat() {
    await this.db.execute(sql`
      INSERT INTO worker_heartbeats (worker_id, kind, version, started_at, last_seen_at, current_task_id, stats)
      VALUES (${this.workerId}, ${this.opts.kind ?? "general"}, ${this.opts.version ?? null}, now(), now(), ${this.currentTask?.id ?? null}, ${JSON.stringify(this.stats)}::jsonb)
      ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), current_task_id = EXCLUDED.current_task_id, stats = EXCLUDED.stats`);
  }

  /** Create system schedules if missing. */
  async ensureSchedules() {
    for (const s of systemSchedules) {
      await this.db.execute(sql`
        INSERT INTO schedules (user_id, kind, interval_minutes) VALUES (NULL, ${s.kind}, ${s.intervalMinutes})
        ON CONFLICT DO NOTHING`);
    }
  }

  /** Enqueue due schedules. Safe with many workers: rows are locked with SKIP LOCKED. */
  async tickScheduler() {
    return this.db.transaction(async (tx) => {
      const due = await tx.execute<{ id: string; user_id: string | null; kind: string; interval_minutes: number; payload: Record<string, unknown> }>(sql`
        SELECT id, user_id, kind, interval_minutes, payload FROM schedules
        WHERE enabled AND next_run_at <= now()
        FOR UPDATE SKIP LOCKED`);
      for (const s of due.rows) {
        await queue.enqueue(tx, { kind: s.kind, userId: s.user_id, payload: s.payload ?? {}, dedupeKey: `schedule:${s.id}` });
        await tx.execute(sql`
          UPDATE schedules SET last_run_at = now(), next_run_at = now() + make_interval(mins => ${s.interval_minutes})
          WHERE id = ${s.id}`);
      }
      return due.rows.length;
    });
  }

  /** Claim and run a single task. Returns false when nothing was available. */
  async runOnce(): Promise<boolean> {
    const task = await queue.claim(this.db, this.workerId, Object.keys(this.opts.handlers));
    if (!task) return false;
    this.currentTask = task;
    const handler = this.opts.handlers[task.kind]!;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(new Error("Task timed out")), task.timeoutSeconds * 1000);
    const hb = setInterval(async () => {
      const ok = await queue.heartbeat(this.db, task.id, this.workerId).catch(() => true);
      if (!ok) ctrl.abort(new Error("Lease lost"));
    }, this.opts.heartbeatMs ?? 15_000);
    const started = Date.now();
    log("info", "task.start", { taskId: task.id, kind: task.kind, attempt: task.attempts });
    try {
      const result = await handler({
        db: this.db,
        task,
        signal: ctrl.signal,
        checkpoint: async (data) => {
          const merged = { ...(task.checkpoint ?? {}), ...data };
          if (!(await queue.saveCheckpoint(this.db, task.id, this.workerId, merged))) throw new NonRetryableError("Lease lost");
          task.checkpoint = merged;
        },
        log: (msg, fields) => log("info", msg, { taskId: task.id, ...fields }),
      });
      await queue.complete(this.db, task.id, this.workerId, result ?? null);
      this.stats.succeeded++;
      log("info", "task.done", { taskId: task.id, kind: task.kind, ms: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await queue.fail(this.db, task.id, this.workerId, message, { retryable: !(err instanceof NonRetryableError) });
      if (outcome === "retry") this.stats.retried++;
      else if (outcome === "blocked") this.stats.blocked++;
      else this.stats.failed++;
      log(outcome === "retry" ? "warn" : "error", "task.failed", { taskId: task.id, kind: task.kind, outcome, error: message });
    } finally {
      clearTimeout(timeout);
      clearInterval(hb);
      this.currentTask = null;
    }
    return true;
  }

  start() {
    const signal = this.stopping.signal;
    const idle = this.opts.idleMs ?? 2000;
    let lastMaintenance = 0;
    this.loopDone = (async () => {
      await this.ensureSchedules();
      while (!signal.aborted) {
        try {
          if (Date.now() - lastMaintenance > 15_000) {
            lastMaintenance = Date.now();
            await this.registerHeartbeat();
            const reclaimed = await queue.reclaimStale(this.db, this.opts.staleSeconds ?? 90);
            if (reclaimed.length) log("warn", "tasks.reclaimed", { tasks: reclaimed });
            await this.tickScheduler();
          }
          const worked = await this.runOnce();
          if (!worked) await sleep(idle, signal);
        } catch (err) {
          log("error", "loop.error", { error: err instanceof Error ? err.message : String(err) });
          await sleep(5000, signal);
        }
      }
    })();
    return this.loopDone;
  }

  /** Graceful stop: finish the current task (Railway sends SIGTERM before killing). */
  async stop() {
    this.stopping.abort();
    await this.loopDone;
    await this.db.execute(sql`DELETE FROM worker_heartbeats WHERE worker_id = ${this.workerId}`).catch(() => undefined);
  }

  health() {
    return { workerId: this.workerId, currentTask: this.currentTask?.kind ?? null, stats: this.stats };
  }
}
