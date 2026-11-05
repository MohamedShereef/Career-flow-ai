/**
 * Saved logins for employer application portals. The user creates the account
 * on the portal themselves; CareerFlow only signs in with it, only on that host.
 * Username and password are encrypted with AES-256-GCM bound to user + host,
 * and are never shown back in the UI.
 */
import { and, desc, eq } from "drizzle-orm";
import { portalLogins } from "@careerflow/db";
import { decrypt, encrypt } from "../crypto";
import { AppError, notFound } from "../errors";
import type { Db, Executor } from "../types";
import { audit } from "./audit";

const aad = (userId: string, host: string, part: "u" | "p") => `portal:${userId}:${host}:${part}`;

export function hostFrom(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("invalid_url", "Paste the portal's link (e.g. https://kbr.wd5.myworkdayjobs.com/KBR_Careers).");
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new AppError("invalid_url", "Paste the portal's full link.");
  if (/(^|\.)(linkedin\.com|google\.com|gmail\.com|outlook\.com|live\.com|microsoft\.com|apple\.com|facebook\.com)$/i.test(u.hostname)) {
    throw new AppError("not_portal", "Only save logins for employer job portals — never your email, LinkedIn or other personal accounts.");
  }
  return u.hostname.toLowerCase();
}

export async function saveLogin(db: Db, userId: string, input: { url: string; username: string; password: string; label?: string | null }) {
  const host = hostFrom(input.url);
  const username = input.username.trim();
  if (!username || username.length > 200) throw new AppError("invalid_login", "Enter the email or username you use on that portal.");
  if (!input.password || input.password.length > 300) throw new AppError("invalid_login", "Enter the password for that portal.");
  const values = {
    userId,
    host,
    label: input.label?.trim().slice(0, 100) || null,
    usernameEnc: encrypt(username, aad(userId, host, "u")),
    passwordEnc: encrypt(input.password, aad(userId, host, "p")),
    lastResult: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(portalLogins)
    .values(values)
    .onConflictDoUpdate({ target: [portalLogins.userId, portalLogins.host], set: values })
    .returning({ id: portalLogins.id, host: portalLogins.host });
  await audit(db, { userId, actor: "user", action: "portal_login.saved", entityType: "portal_login", entityId: row!.id, metadata: { host } });
  return row!;
}

/** For the UI: never includes the secrets. */
export async function listLogins(db: Executor, userId: string) {
  const rows = await db.select().from(portalLogins).where(eq(portalLogins.userId, userId)).orderBy(desc(portalLogins.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    label: r.label,
    username: maskUser(decrypt(r.usernameEnc, aad(userId, r.host, "u"))),
    lastUsedAt: r.lastUsedAt,
    lastResult: r.lastResult,
    updatedAt: r.updatedAt,
  }));
}

function maskUser(u: string) {
  const [name, domain] = u.split("@");
  if (!domain) return u.length > 3 ? `${u.slice(0, 2)}…` : u;
  return `${name!.slice(0, 2)}…@${domain}`;
}

export async function deleteLogin(db: Db, userId: string, id: string) {
  const res = await db.delete(portalLogins).where(and(eq(portalLogins.id, id), eq(portalLogins.userId, userId))).returning({ host: portalLogins.host });
  if (!res.length) throw notFound("Saved login");
  await audit(db, { userId, actor: "user", action: "portal_login.deleted", entityType: "portal_login", entityId: id, metadata: { host: res[0]!.host } });
}

/** Worker only: the credentials for exactly this host, or null. */
export async function loginForHost(db: Executor, userId: string, host: string) {
  const h = host.toLowerCase();
  const [r] = await db.select().from(portalLogins).where(and(eq(portalLogins.userId, userId), eq(portalLogins.host, h)));
  if (!r) return null;
  return { id: r.id, host: h, username: decrypt(r.usernameEnc, aad(userId, h, "u")), password: decrypt(r.passwordEnc, aad(userId, h, "p")) };
}

export async function recordLoginResult(db: Executor, id: string, result: "ok" | "failed" | "verification_required") {
  await db.update(portalLogins).set({ lastUsedAt: new Date(), lastResult: result }).where(eq(portalLogins.id, id));
}
