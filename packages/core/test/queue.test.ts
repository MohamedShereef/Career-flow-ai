import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { tasks } from "@careerflow/db";
import * as queue from "../src/services/queue";
import { closeDb, testDb, truncateQueue } from "../../../test/helpers";

afterAll(closeDb);
beforeEach(truncateQueue);

describe("durable queue", () => {
  it("never hands the same task to two workers", async () => {
    const db = testDb();
    for (let i = 0; i < 20; i++) await queue.enqueue(db, { kind: "test.job", payload: { i } });
    const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => queue.claim(db, `w${i}`)));
    const ids = claims.filter(Boolean).map((t) => t!.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("dedupes pending tasks but allows a new one after completion", async () => {
    const db = testDb();
    const first = await queue.enqueue(db, { kind: "k", dedupeKey: "same" });
    expect(await queue.enqueue(db, { kind: "k", dedupeKey: "same" })).toBeNull();
    const t = await queue.claim(db, "w");
    await queue.complete(db, t!.id, "w");
    expect(first).not.toBeNull();
    expect(await queue.enqueue(db, { kind: "k", dedupeKey: "same" })).not.toBeNull();
  });

  it("retries with backoff, then dies", async () => {
    const db = testDb();
    await queue.enqueue(db, { kind: "k", maxAttempts: 2 });
    let t = await queue.claim(db, "w");
    expect(await queue.fail(db, t!.id, "w", "boom")).toBe("retry");
    await db.update(tasks).set({ runAt: sql`now()` });
    t = await queue.claim(db, "w");
    expect(t?.attempts).toBe(2);
    expect(await queue.fail(db, t!.id, "w", "boom")).toBe("dead");
  });

  it("never auto-retries an interrupted irreversible step", async () => {
    const db = testDb();
    await queue.enqueue(db, { kind: "application.submit", maxAttempts: 5 });
    const t = await queue.claim(db, "w1");
    await queue.saveCheckpoint(db, t!.id, "w1", { step: "submit_clicked", irreversible: true });
    expect(await queue.fail(db, t!.id, "w1", "timeout after click")).toBe("blocked");
    expect(await queue.claim(db, "w2")).toBeNull();
  });

  it("reclaims tasks from dead workers and preserves checkpoints", async () => {
    const db = testDb();
    await queue.enqueue(db, { kind: "k" });
    await queue.enqueue(db, { kind: "submit" });
    const a = await queue.claim(db, "dead-worker", ["k"]);
    const b = await queue.claim(db, "dead-worker", ["submit"]);
    await queue.saveCheckpoint(db, a!.id, "dead-worker", { step: "form_filled" });
    await queue.saveCheckpoint(db, b!.id, "dead-worker", { irreversible: true });
    await db.update(tasks).set({ heartbeatAt: sql`now() - interval '5 minutes'` });

    const reclaimed = await queue.reclaimStale(db, 90);
    expect(reclaimed.map((r) => r.status).sort()).toEqual(["blocked", "queued"]);

    const resumed = await queue.claim(db, "new-worker");
    expect(resumed?.id).toBe(a!.id);
    expect(resumed?.checkpoint).toEqual({ step: "form_filled" });
    // the old worker can no longer write
    expect(await queue.complete(db, a!.id, "dead-worker")).toBe(false);
    expect(await queue.heartbeat(db, a!.id, "dead-worker")).toBe(false);
    const [blocked] = await db.select().from(tasks).where(eq(tasks.id, b!.id));
    expect(blocked!.status).toBe("blocked");
  });
});
