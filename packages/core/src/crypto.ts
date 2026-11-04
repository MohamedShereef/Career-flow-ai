/**
 * Field-level encryption (AES-256-GCM) for sensitive applicant data and OAuth
 * tokens, plus keyed hashing for lookups that must not reveal plaintext.
 *
 * Ciphertext format: "v1.<base64url iv>.<base64url tag>.<base64url data>"
 * Keys: APP_ENCRYPTION_KEY (32 bytes, base64). Rotation: add
 * APP_ENCRYPTION_KEY_PREVIOUS; decrypt tries current then previous.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

function loadKey(value: string | undefined, name: string): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes encoded as base64`);
  return key;
}

function keys(): Buffer[] {
  const current = loadKey(process.env.APP_ENCRYPTION_KEY, "APP_ENCRYPTION_KEY");
  if (!current) throw new Error("APP_ENCRYPTION_KEY is not set");
  const previous = loadKey(process.env.APP_ENCRYPTION_KEY_PREVIOUS, "APP_ENCRYPTION_KEY_PREVIOUS");
  return previous ? [current, previous] : [current];
}

export function encrypt(plaintext: string, aad = ""): string {
  const [key] = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key!, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(payload: string, aad = ""): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unsupported ciphertext format");
  const [, ivB, tagB, dataB] = parts as [string, string, string, string];
  let lastErr: unknown;
  for (const key of keys()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
      if (aad) decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tagB, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error("Decryption failed", { cause: lastErr });
}

export const encryptNullable = (v: string | null | undefined, aad = "") =>
  v === null || v === undefined || v === "" ? null : encrypt(v, aad);
export const decryptNullable = (v: string | null | undefined, aad = "") => (v ? decrypt(v, aad) : null);

/** Keyed hash for equality lookups (question hashes, IP hashes). */
export function keyedHash(value: string, purpose: string): string {
  const secret = process.env.APP_HASH_KEY ?? process.env.APP_ENCRYPTION_KEY;
  if (!secret) throw new Error("APP_HASH_KEY or APP_ENCRYPTION_KEY must be set");
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("base64url");
}

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
