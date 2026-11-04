import "server-only";
import { AppError } from "@careerflow/core";

export type ActionState = { ok?: string; error?: string; at?: number } | undefined;

/** Converts thrown errors to a safe message; unknown errors are logged, not shown. */
export async function runAction(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const ok = await fn();
    return { ok: ok || "Saved.", at: Date.now() };
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof AppError) return { error: err.userMessage, at: Date.now() };
    console.error("action failed", err);
    return { error: "Something went wrong on our side. Please try again.", at: Date.now() };
  }
}

export const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};
export const optStr = (fd: FormData, key: string) => {
  const v = str(fd, key).trim();
  return v === "" ? null : v;
};
export const list = (fd: FormData, key: string) =>
  str(fd, key)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
