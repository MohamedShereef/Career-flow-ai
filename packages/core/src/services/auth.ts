import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { applicantProfiles, automationSettings, passwordResetTokens, sessions, users } from "@careerflow/db";
import { z } from "zod";
import { keyedHash, randomToken, sha256 } from "../crypto";
import { AppError } from "../errors";
import { normalizeEmail } from "../normalize";
import { hashPassword, passwordProblems, verifyPassword } from "../password";
import type { Db, RequestContext } from "../types";
import { audit } from "./audit";
import { enforce } from "./rate-limit";

export const SESSION_TTL_DAYS = 30;
const RESET_TTL_MINUTES = 60;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

const emailSchema = z.string().trim().email().max(254);

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "admin";
  sessionId: string;
}

function ipKey(ctx: RequestContext) {
  return ctx.ip ? keyedHash(ctx.ip, "ip") : "unknown";
}

export async function createSession(db: Db, userId: string, ctx: RequestContext = {}) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      ipHash: ctx.ip ? keyedHash(ctx.ip, "ip") : null,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { token, expiresAt, sessionId: row!.id };
}

export async function signUp(
  db: Db,
  input: { email: string; password: string; displayName?: string },
  ctx: RequestContext = {},
) {
  await enforce(db, `signup:${ipKey(ctx)}`, 10, 3600);
  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) throw new AppError("invalid_email", "Enter a valid email address.");
  const email = normalizeEmail(parsed.data);
  const problem = passwordProblems(input.password);
  if (problem) throw new AppError("weak_password", problem);

  if (process.env.SIGNUP_MODE === "closed") {
    const allowed = (process.env.SIGNUP_ALLOWLIST ?? "").split(",").map((e) => normalizeEmail(e)).filter(Boolean);
    if (!allowed.includes(email)) throw new AppError("signup_closed", "Sign-up is currently by invitation only.", 403);
  }

  const passwordHash = await hashPassword(input.password);
  const isAdmin = !!process.env.ADMIN_EMAIL && normalizeEmail(process.env.ADMIN_EMAIL) === email;

  const user = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (existing.length) throw new AppError("email_taken", "An account with this email already exists. Try signing in.");
    const [u] = await tx
      .insert(users)
      .values({ email, passwordHash, displayName: input.displayName?.trim() || null, role: isAdmin ? "admin" : "user" })
      .returning();
    await tx.insert(applicantProfiles).values({ userId: u!.id, fullName: input.displayName?.trim() || null, contactEmail: email });
    await tx.insert(automationSettings).values({ userId: u!.id });
    await audit(tx, { userId: u!.id, actor: "user", action: "auth.signup", ip: ctx.ip });
    return u!;
  });

  const session = await createSession(db, user.id, ctx);
  return { user, ...session };
}

export async function signIn(db: Db, input: { email: string; password: string }, ctx: RequestContext = {}) {
  const email = normalizeEmail(input.email ?? "");
  await enforce(db, `login-ip:${ipKey(ctx)}`, 30, 900);
  await enforce(db, `login-email:${keyedHash(email, "email")}`, 15, 900);

  const generic = new AppError("invalid_credentials", "Email or password is incorrect.", 401);
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (!user) {
    // Spend comparable time so response timing doesn't reveal account existence.
    await hashPassword(input.password ?? "");
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("locked", "Too many failed attempts. Try again in a few minutes or reset your password.", 423);
  }
  const ok = await verifyPassword(input.password ?? "", user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await audit(db, { userId: user.id, actor: "user", action: "auth.login_failed", ip: ctx.ip });
    throw generic;
  }
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
  await audit(db, { userId: user.id, actor: "user", action: "auth.login", ip: ctx.ip });
  const session = await createSession(db, user.id, ctx);
  return { user, ...session };
}

export async function validateSession(db: Db, token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  if (row.passwordChangedAt && row.createdAt < row.passwordChangedAt) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 3_600_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role, sessionId: row.sessionId };
}

export async function signOut(db: Db, token: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeOtherSessions(db: Db, userId: string, keepSessionId?: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        keepSessionId ? sql`${sessions.id} <> ${keepSessionId}` : undefined,
      ),
    );
}

export async function listSessions(db: Db, userId: string) {
  return db
    .select({ id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .orderBy(sql`${sessions.lastSeenAt} desc`);
}

/**
 * Always resolves without revealing whether the account exists. Returns the
 * raw token only so the caller can email it; it is stored hashed.
 */
export async function requestPasswordReset(db: Db, emailInput: string, ctx: RequestContext = {}) {
  const email = normalizeEmail(emailInput ?? "");
  await enforce(db, `reset-ip:${ipKey(ctx)}`, 10, 3600);
  await enforce(db, `reset-email:${keyedHash(email, "email")}`, 3, 3600);
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (!user) return null;
  const token = randomToken(32);
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
  });
  await audit(db, { userId: user.id, actor: "user", action: "auth.reset_requested", ip: ctx.ip });
  return { token, email: user.email };
}

export async function resetPassword(db: Db, token: string, newPassword: string, ctx: RequestContext = {}) {
  const problem = passwordProblems(newPassword);
  if (problem) throw new AppError("weak_password", problem);
  const invalid = new AppError("invalid_token", "This reset link is invalid or has expired. Request a new one.");
  if (!token) throw invalid;
  const passwordHash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, sha256(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    if (!row) throw invalid;
    const now = new Date();
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: sql`now()`, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, row.userId));
    await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
    await audit(tx, { userId: row.userId, actor: "user", action: "auth.password_reset", ip: ctx.ip });
    return { userId: row.userId };
  });
}

export async function changePassword(
  db: Db,
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestContext = {},
) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError("invalid_credentials", "Current password is incorrect.", 401);
  }
  const problem = passwordProblems(newPassword);
  if (problem) throw new AppError("weak_password", problem);
  // passwordChangedAt invalidates all existing sessions; caller issues a fresh one.
  const now = new Date();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: sql`now()`, updatedAt: now })
    .where(eq(users.id, userId));
  await revokeOtherSessions(db, userId);
  await audit(db, { userId, actor: "user", action: "auth.password_changed", ip: ctx.ip });
  return createSession(db, userId, ctx);
}
