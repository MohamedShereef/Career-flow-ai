import { eq, sql } from "drizzle-orm";
import { automationSettings, dailyUsage } from "@careerflow/db";
import { z } from "zod";
import { AppError } from "../errors";
import type { Db, Executor } from "../types";
import { audit } from "./audit";

export async function getSettings(db: Executor, userId: string) {
  const [s] = await db.select().from(automationSettings).where(eq(automationSettings.userId, userId));
  if (s) return s;
  const [created] = await db.insert(automationSettings).values({ userId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(automationSettings).where(eq(automationSettings.userId, userId)))[0]!;
}

/**
 * Conservative pilot ceilings from the spec. Raising past them requires the
 * pilot to be complete (enforced in Phase 4 once real submissions exist).
 */
export const PILOT_LIMITS = { maxSubmissionsPerDay: 5, maxInspectionsPerDay: 15, maxBatchSize: 5 } as const;

const settingsSchema = z
  .object({
    maxSubmissionsPerDay: z.coerce.number().int().min(0).max(PILOT_LIMITS.maxSubmissionsPerDay),
    maxInspectionsPerDay: z.coerce.number().int().min(0).max(PILOT_LIMITS.maxInspectionsPerDay),
    maxBatchSize: z.coerce.number().int().min(1).max(PILOT_LIMITS.maxBatchSize),
    matchThreshold: z.coerce.number().int().min(0).max(100),
    discoveryIntervalHours: z.coerce.number().int().min(1).max(168),
    timezone: z.string().min(1).max(60),
  })
  .partial();

export async function updateSettings(db: Db, userId: string, input: unknown) {
  const r = settingsSchema.safeParse(input);
  if (!r.success) throw new AppError("invalid_settings", r.error.issues[0]?.message ?? "Invalid settings.");
  await getSettings(db, userId);
  const [row] = await db
    .update(automationSettings)
    .set({ ...r.data, updatedAt: new Date() })
    .where(eq(automationSettings.userId, userId))
    .returning();
  await audit(db, { userId, actor: "user", action: "settings.updated", metadata: r.data });
  return row!;
}

export type ConsentKind = "automation" | "email_tracking" | "outreach";

export async function setConsent(db: Db, userId: string, kind: ConsentKind, granted: boolean) {
  const col = { automation: "automationConsentAt", email_tracking: "emailTrackingConsentAt", outreach: "outreachConsentAt" } as const;
  await getSettings(db, userId);
  await db
    .update(automationSettings)
    .set({ [col[kind]]: granted ? new Date() : null, updatedAt: new Date() })
    .where(eq(automationSettings.userId, userId));
  await audit(db, { userId, actor: "user", action: granted ? "consent.granted" : "consent.revoked", metadata: { kind } });
}

/**
 * Atomically consume one unit of today's quota. Returns false when the limit
 * is reached. The conditional upsert makes this safe under concurrency.
 */
export async function consumeDailyQuota(
  db: Executor,
  userId: string,
  kind: "submissions" | "inspections",
  limit: number,
  day: string,
): Promise<boolean> {
  if (limit <= 0) return false;
  const col = sql.identifier(kind);
  const res = await db.execute(sql`
    INSERT INTO daily_usage (user_id, day, ${col}) VALUES (${userId}, ${day}, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET ${col} = daily_usage.${col} + 1
    WHERE daily_usage.${col} < ${limit}
    RETURNING ${col}`);
  return res.rows.length > 0;
}

export async function todayUsage(db: Executor, userId: string, day: string) {
  const [r] = await db.select().from(dailyUsage).where(sql`${dailyUsage.userId} = ${userId} AND ${dailyUsage.day} = ${day}`);
  return { submissions: r?.submissions ?? 0, inspections: r?.inspections ?? 0, aiCostUsd: Number(r?.aiCostUsd ?? 0) };
}

/** YYYY-MM-DD in the user's timezone (quotas reset at local midnight). */
export function localDay(timezone: string, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
