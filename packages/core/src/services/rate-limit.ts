import { sql } from "drizzle-orm";
import { AppError } from "../errors";
import type { Executor } from "../types";

/**
 * Fixed-window counter stored in Postgres (no Redis needed).
 * Returns the count in the current window after incrementing.
 */
export async function hit(db: Executor, key: string, windowSeconds: number): Promise<number> {
  const res = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   THEN now() ELSE rate_limits.window_start END
    RETURNING count`);
  return Number(res.rows[0]?.count ?? 0);
}

export async function enforce(db: Executor, key: string, limit: number, windowSeconds: number) {
  const count = await hit(db, key, windowSeconds);
  if (count > limit) {
    throw new AppError("rate_limited", "Too many attempts. Please wait a few minutes and try again.", 429);
  }
}
