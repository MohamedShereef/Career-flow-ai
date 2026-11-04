import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schedules, tasks } from "@careerflow/db";
import { queue } from "@careerflow/core";
import { NonRetryableError } from "../src/handlers";
import { Runner } from "../src/runner";
import { closeDb, testDb, truncateQueue } from "../../../test/helpers";

afterAll(closeDb);
beforeEach(async () => {
  await truncateQueue();
  await testDb().execute(sql`TRUNCATE schedules`);
});

describe("worker runner", () => {
  it("runs a task, saves checkpoints and completes it", async () => {
    const db = testDb();
    const seen: unknown[] = [];
    const r = new Runner({
      db,
      workerId: "t1",
      handlers: {
        "demo.steps": async (ctx) => {
          seen.push(ctx.task.checkpoint);
          await ctx.checkpoint({ step: "one" });
          return { ok: true };
        },
      },
    });
    const t = await queue.enqueue(db, { kind: "demo.steps" });
    expect(await r.runOnce()).toBe(true);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, t!.id));
    expect(row!.status).toBe("succeeded");
    expect(row!.checkpoint).toEqual({ step: "one" });
  });

  it("does not claim kinds it has no handler for", async () => {
    const db = testDb();
    await queue.enqueue(db, { kind: "application.submit" });
    const r = new Runner({ db, workerId: "t2", handlers: { "system.ping": async () => null } });
    expect(await r.runOnce()).toBe(false);
  });

  it("non-retryable errors go straight to dead; irreversible ones to blocked", async () => {
    const db = testDb();
    const r = new Runner({
      db,
      workerId: "t3",
      handlers: {
        "demo.fatal": async () => {
          throw new NonRetryableError("bad input");
        },
        "demo.submit": async (ctx) => {
          await ctx.checkpoint({ irreversible: true });
          throw new Error("navigation timeout after submit");
        },
      },
    });
    const a = await queue.enqueue(db, { kind: "demo.fatal" });
    const b = await queue.enqueue(db, { kind: "demo.submit", maxAttempts: 5 });
    await r.runOnce();
    await r.runOnce();
    const rows = await db.select().from(tasks);
    expect(rows.find((x) => x.id === a!.id)!.status).toBe("dead");
    expect(rows.find((x) => x.id === b!.id)!.status).toBe("blocked");
  });

  it("scheduler enqueues each due schedule once even with concurrent workers", async () => {
    const db = testDb();
    await db.insert(schedules).values({ kind: "system.ping", intervalMinutes: 60 });
    const w1 = new Runner({ db, workerId: "s1", handlers: {} });
    const w2 = new Runner({ db, workerId: "s2", handlers: {} });
    await Promise.all([w1.tickScheduler(), w2.tickScheduler(), w1.tickScheduler()]);
    const queued = await db.select().from(tasks).where(eq(tasks.kind, "system.ping"));
    expect(queued).toHaveLength(1);
    const [s] = await db.select().from(schedules);
    expect(s!.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });
});
