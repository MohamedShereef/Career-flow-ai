/**
 * Private object storage. Driver "s3" works with Cloudflare R2, AWS S3,
 * Railway buckets or any S3-compatible store. Driver "local" is for
 * development and tests only. Objects are never public: downloads stream
 * through authenticated routes after an ownership check.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements ObjectStorage {
  constructor(private root: string) {}
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body, { mode: 0o600 });
  }
  get(key: string) {
    return readFile(this.file(key));
  }
  async remove(key: string) {
    await rm(this.file(key), { force: true });
  }
}

class S3Storage implements ObjectStorage {
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;
  constructor(private bucket: string) {
    this.clientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: process.env.S3_REGION ?? "auto",
          endpoint: process.env.S3_ENDPOINT || undefined,
          forcePathStyle: !!process.env.S3_ENDPOINT,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
          },
        }),
    );
  }
  async put(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: process.env.S3_SSE === "off" ? undefined : "AES256" }),
    );
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const out = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  }
  async remove(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (instance) return instance;
  const driver = process.env.STORAGE_DRIVER ?? (process.env.S3_BUCKET ? "s3" : "local");
  if (driver === "s3") {
    if (!process.env.S3_BUCKET) throw new Error("S3_BUCKET is required for STORAGE_DRIVER=s3");
    instance = new S3Storage(process.env.S3_BUCKET);
  } else {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_STORAGE !== "true") {
      throw new Error("Local storage is disabled in production. Configure S3_BUCKET (e.g. Cloudflare R2).");
    }
    instance = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? path.resolve(process.cwd(), "storage"));
  }
  return instance;
}

export function setStorageForTests(s: ObjectStorage | null) {
  instance = s;
}
