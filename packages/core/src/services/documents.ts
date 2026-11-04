import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { documents } from "@careerflow/db";
import { randomUUID } from "node:crypto";
import { sha256 } from "../crypto";
import { AppError, notFound } from "../errors";
import { getStorage } from "../storage";
import type { Db, Executor } from "../types";
import { audit } from "./audit";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** Verify content by magic bytes — never trust the browser-supplied type alone. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return buf.includes(Buffer.from("word/")) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null;
  }
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

const safeName = (n: string) =>
  n.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

export type UserDocumentKind = "cv_original" | "certificate" | "supporting";

export async function uploadDocument(
  db: Db,
  userId: string,
  file: { name: string; bytes: Buffer },
  kind: UserDocumentKind,
  label?: string | null,
) {
  if (file.bytes.length === 0) throw new AppError("empty_file", "The file is empty.");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new AppError("file_too_large", "Files must be 10 MB or smaller.");
  const mime = sniffMime(file.bytes);
  if (!mime || !ALLOWED[mime]) throw new AppError("bad_type", "Upload a PDF or Word (.docx) file. Certificates may also be PNG or JPG.");
  if (kind === "cv_original" && !mime.startsWith("application/")) throw new AppError("bad_type", "A CV must be a PDF or Word (.docx) file.");

  const key = `users/${userId}/${kind}/${randomUUID()}.${ALLOWED[mime]}`;
  await getStorage().put(key, file.bytes, mime);

  try {
    return await db.transaction(async (tx) => {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.kind, "cv_original"), eq(documents.isPrimary, true), isNull(documents.deletedAt)))) as [{ n: number }];
      const [row] = await tx
        .insert(documents)
        .values({
          userId,
          kind,
          storageKey: key,
          filename: safeName(file.name),
          mimeType: mime,
          sizeBytes: file.bytes.length,
          sha256: sha256(file.bytes),
          isPrimary: kind === "cv_original" && n === 0,
          label: label?.trim() || null,
        })
        .returning();
      await audit(tx, { userId, actor: "user", action: "document.uploaded", entityType: "document", entityId: row!.id, metadata: { kind } });
      return row!;
    });
  } catch (err) {
    await getStorage().remove(key).catch(() => undefined);
    throw err;
  }
}

export async function listDocuments(db: Executor, userId: string, kinds?: string[]) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.isPrimary), desc(documents.createdAt));
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}

export async function getDocumentForDownload(db: Executor, userId: string, id: string) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId), isNull(documents.deletedAt)));
  if (!doc) throw notFound("Document");
  const bytes = await getStorage().get(doc.storageKey);
  if (sha256(bytes) !== doc.sha256) throw new AppError("integrity", "The stored file failed an integrity check.", 500);
  return { doc, bytes };
}

export async function setPrimaryCv(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId), eq(documents.kind, "cv_original"), isNull(documents.deletedAt)));
    if (!doc) throw notFound("CV");
    await tx.update(documents).set({ isPrimary: false }).where(and(eq(documents.userId, userId), eq(documents.kind, "cv_original")));
    await tx.update(documents).set({ isPrimary: true }).where(eq(documents.id, id));
  });
}

/** Soft delete keeps evidence links intact; the object is removed from storage. */
export async function deleteDocument(db: Db, userId: string, id: string) {
  const [doc] = await db
    .update(documents)
    .set({ deletedAt: new Date(), isPrimary: false })
    .where(and(eq(documents.id, id), eq(documents.userId, userId), isNull(documents.deletedAt), sql`${documents.kind} IN ('cv_original','certificate','supporting')`))
    .returning();
  if (!doc) throw notFound("Document");
  await getStorage().remove(doc.storageKey).catch(() => undefined);
  await audit(db, { userId, actor: "user", action: "document.deleted", entityType: "document", entityId: id });
}
