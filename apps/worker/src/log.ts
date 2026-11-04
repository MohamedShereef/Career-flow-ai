/** Structured JSON logs (Railway/Logtail/Datadog friendly) with secret redaction. */
const SECRET_KEYS = /pass(word)?|token|secret|authorization|cookie|api[_-]?key|answer|salary|phone/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]),
  );
}

type Level = "debug" | "info" | "warn" | "error";
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}
