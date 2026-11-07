/**
 * The CareerFlow Chrome extension finishes applications in the user's own browser: it fills the
 * employer's form with the answers the user reviewed, and the user ticks any robot check and presses
 * Submit themselves. This service links the extension to an account and serves it the answers.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { applications, documents, extensionTokens, jobs } from "@careerflow/db";
import { randomToken, sha256 } from "../crypto";
import { AppError, notFound } from "../errors";
import type { Db } from "../types";
import { audit } from "./audit";
import * as autoapply from "./autoapply";
import { markSubmitted } from "./applications";

export async function createToken(db: Db, userId: string, name = "Chrome") {
  const raw = `cfx_${randomToken(32)}`;
  const [row] = await db.insert(extensionTokens).values({ userId, tokenHash: sha256(raw), name: name.slice(0, 60) }).returning();
  await audit(db, { userId, actor: "user", action: "extension.linked", entityType: "extension_token", entityId: row!.id });
  return { id: row!.id, token: raw };
}

export async function listTokens(db: Db, userId: string) {
  return db.select({ id: extensionTokens.id, name: extensionTokens.name, createdAt: extensionTokens.createdAt, lastUsedAt: extensionTokens.lastUsedAt }).from(extensionTokens).where(and(eq(extensionTokens.userId, userId), isNull(extensionTokens.revokedAt))).orderBy(desc(extensionTokens.createdAt));
}

export async function revokeToken(db: Db, userId: string, id: string) {
  await db.update(extensionTokens).set({ revokedAt: new Date() }).where(and(eq(extensionTokens.id, id), eq(extensionTokens.userId, userId)));
}

/** The account behind an extension token, or null. */
export async function authenticate(db: Db, raw: string | null | undefined) {
  if (!raw || !raw.startsWith("cfx_") || raw.length > 100) return null;
  const [t] = await db.select().from(extensionTokens).where(and(eq(extensionTokens.tokenHash, sha256(raw)), isNull(extensionTokens.revokedAt)));
  if (!t) return null;
  await db.update(extensionTokens).set({ lastUsedAt: new Date() }).where(eq(extensionTokens.id, t.id));
  return t.userId;
}

const GENERIC = new Set(["apply", "application", "jobs", "job", "careers", "career", "en", "us", "en-us", "en_us", "j", "view", "posting", "postings", "details", "sites", "hcmui", "candidateexperience", "requisitions", "search"]);
/** Parts of a job link that identify the posting (job codes, slugs), not the site's fixed words. */
function postingTokens(url: string) {
  try {
    const u = new URL(url);
    const parts = [...u.pathname.split(/[/_.-]+/), ...[...u.searchParams.values()]].map((x) => x.toLowerCase()).filter((x) => x.length >= 5 && !GENERIC.has(x));
    return { host: u.hostname.replace(/^www\./, ""), parts: new Set(parts) };
  } catch {
    return null;
  }
}

const OPEN = ["awaiting_approval", "needs_user_action", "processing", "prepared"] as const;

/** The application (not yet sent) whose job is on this page. */
export async function findForUrl(db: Db, userId: string, url: string) {
  const page = postingTokens(url);
  if (!page) return null;
  const rows = await db
    .select({ a: applications, j: jobs })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(eq(applications.userId, userId), inArray(applications.status, [...OPEN])))
    .orderBy(desc(applications.updatedAt))
    .limit(100);
  let best: { row: (typeof rows)[number]; score: number } | null = null;
  for (const row of rows) {
    for (const link of [autoapply.applyUrlFor(row.a, row.j), row.j.applyUrl, row.j.sourceUrl]) {
      const t = postingTokens(link);
      if (!t) continue;
      const sameSite = t.host === page.host || t.host.endsWith(`.${page.host}`) || page.host.endsWith(`.${t.host}`);
      if (!sameSite) continue;
      const shared = [...t.parts].filter((p) => page.parts.has(p)).length;
      const score = shared * 10 + 1;
      if (shared && (!best || score > best.score)) best = { row, score };
    }
  }
  return best?.row ?? null;
}

export type HandoffAnswer = { key: string; label: string; type: string; value: string | string[] | boolean | null; file?: { documentId: string; filename: string }[] };

/** What the extension fills: the answers of the newest preview, with the files to attach. */
export async function handoff(db: Db, userId: string, url: string) {
  const row = await findForUrl(db, userId, url);
  if (!row) return null;
  const preview = await autoapply.latestPreview(db, userId, row.a.id);
  if (!preview) throw new AppError("no_preview", "CareerFlow hasn't prepared this application yet. Start it in CareerFlow first.");
  const docs = async (ids: (string | null)[]) => {
    const list = ids.filter((x): x is string => !!x);
    if (!list.length) return [];
    return (await db.select({ id: documents.id, filename: documents.filename }).from(documents).where(and(eq(documents.userId, userId), inArray(documents.id, list), isNull(documents.deletedAt)))).map((d) => ({ documentId: d.id, filename: d.filename }));
  };
  const certs = (await db.execute(sql`SELECT id FROM documents WHERE user_id = ${userId} AND kind = 'certificate' AND deleted_at IS NULL ORDER BY created_at LIMIT 8`)).rows as Array<{ id: string }>;
  const answers: HandoffAnswer[] = [];
  for (const a of preview.data.answers) {
    const v = a.value;
    const base = { key: a.key.replace(/^p\d+\|/, ""), label: a.label, type: a.type };
    if (v.kind === "file") {
      const ids = v.doc === "cv" ? [row.a.tailoredCvDocumentId] : v.doc === "cover_letter" ? [row.a.coverLetterDocumentId] : certs.map((c) => c.id);
      answers.push({ ...base, value: null, file: await docs(ids) });
    } else answers.push({ ...base, value: v.kind === "text" ? v.value : v.kind === "multi" ? v.values : v.value });
  }
  return { applicationId: row.a.id, jobTitle: row.j.title, company: row.j.companyName, version: preview.version, answers };
}

/** A file of this user's, for the extension to attach. */
export async function fileFor(db: Db, userId: string, documentId: string) {
  const { getDocumentForDownload } = await import("./documents");
  return getDocumentForDownload(db, userId, documentId);
}

/** The user pressed Submit in their browser and the employer's page confirmed it. */
export async function markSent(db: Db, userId: string, applicationId: string, info: { url: string; confirmation: string }) {
  const [a] = await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
  if (!a) throw notFound("Application");
  const r = await markSubmitted(db, userId, applicationId);
  await audit(db, { userId, actor: "user", action: "application.sent_from_browser", entityType: "application", entityId: applicationId, metadata: { url: info.url.slice(0, 300), confirmation: info.confirmation.slice(0, 200) } });
  return r;
}
