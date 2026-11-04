/**
 * OpenAI access for every agent. One entry point (`structured`) that:
 * - asks for JSON matching a strict schema,
 * - records an ai_decisions row (stage, model, outcome, latency, tokens, cost),
 * - says plainly when AI is unavailable instead of pretending a rule was AI.
 */
import { aiDecisions } from "@careerflow/db";
import { AppError } from "./errors";
import type { Executor } from "./types";

export interface AiRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface AiRawResponse {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type AiTransport = (req: AiRequest, model: string) => Promise<AiRawResponse>;

/** USD per 1M tokens [input, output]. Approximate; override with OPENAI_PRICE_IN / OPENAI_PRICE_OUT. */
const PRICES: Record<string, [number, number]> = {
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4o-mini": [0.15, 0.6],
};

export function estimateCost(model: string, input = 0, output = 0): number | null {
  const envIn = Number(process.env.OPENAI_PRICE_IN);
  const envOut = Number(process.env.OPENAI_PRICE_OUT);
  const p: [number, number] | undefined =
    envIn > 0 && envOut > 0 ? [envIn, envOut] : PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k + "-")) ?? ""];
  if (!p) return null;
  return (input * p[0] + output * p[1]) / 1_000_000;
}

export const aiModel = () => process.env.OPENAI_MODEL || "gpt-5-mini";
export const aiConfigured = () => !!process.env.OPENAI_API_KEY || !!testTransport;

const openAiTransport: AiTransport = async (req, model) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AppError("ai_unavailable", "The AI engine isn't connected yet (no OpenAI API key on the server).", 503);
  const reasoning = /^(gpt-5|o\d)/.test(model);
  const res = await fetch(`${(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      max_completion_tokens: req.maxOutputTokens ?? 8000,
      ...(reasoning ? { reasoning_effort: "low" } : { temperature: 0.2 }),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
    model?: string;
    choices?: Array<{ message?: { content?: string; refusal?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (!res.ok) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new AppError("ai_auth", "The OpenAI API key was rejected. Check the key on the server.", 502);
    if (res.status === 429) throw new AppError("ai_rate_limited", "OpenAI is rate-limiting or the account has no credit left. Try again later or add credit.", 503);
    throw new AppError("ai_error", `The AI service returned an error: ${msg.slice(0, 200)}`, 502);
  }
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new AppError("ai_refused", "The AI declined this request.", 502);
  if (!choice?.message?.content) {
    throw new AppError("ai_empty", choice?.finish_reason === "length" ? "The AI response was cut off. Try a shorter document." : "The AI returned no content.", 502);
  }
  return {
    content: choice.message.content,
    model: body.model ?? model,
    inputTokens: body.usage?.prompt_tokens,
    outputTokens: body.usage?.completion_tokens,
  };
};

let testTransport: AiTransport | null = null;
export function setAiTransportForTests(t: AiTransport | null) {
  testTransport = t;
}

export interface StructuredOptions<T> extends AiRequest {
  db: Executor;
  userId: string;
  stage: string;
  agent: string;
  entityType?: string;
  entityId?: string;
  inputSummary?: string;
  /** Short label stored as the decision outcome. */
  outcome?: (result: T) => string;
}

export async function structured<T>(opts: StructuredOptions<T>): Promise<{ data: T; decisionId: string }> {
  const model = aiModel();
  const started = Date.now();
  const base = {
    userId: opts.userId,
    stage: opts.stage,
    agent: opts.agent,
    entityType: opts.entityType,
    entityId: opts.entityId,
    method: "ai" as const,
    model,
    inputSummary: opts.inputSummary?.slice(0, 500),
  };
  if (!aiConfigured()) {
    await opts.db.insert(aiDecisions).values({ ...base, status: "unavailable", outcome: "skipped", error: "OPENAI_API_KEY not set" });
    throw new AppError("ai_unavailable", "The AI engine isn't connected yet (no OpenAI API key on the server).", 503);
  }
  try {
    const raw = await (testTransport ?? openAiTransport)(opts, model);
    const data = JSON.parse(raw.content) as T;
    const [row] = await opts.db
      .insert(aiDecisions)
      .values({
        ...base,
        model: raw.model,
        status: "ok",
        outcome: opts.outcome?.(data) ?? "ok",
        latencyMs: Date.now() - started,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        costUsd: estimateCost(raw.model, raw.inputTokens, raw.outputTokens)?.toFixed(6) ?? null,
      })
      .returning({ id: aiDecisions.id });
    return { data, decisionId: row!.id };
  } catch (err) {
    await opts.db.insert(aiDecisions).values({
      ...base,
      status: "error",
      outcome: "failed",
      latencyMs: Date.now() - started,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    if (err instanceof AppError) throw err;
    throw new AppError("ai_error", "The AI step failed. Please try again.", 502);
  }
}

// ── JSON-schema helpers (strict mode: every property required, nulls explicit) ──
type S = Record<string, unknown>;
export const js = {
  str: (description?: string): S => ({ type: "string", ...(description ? { description } : {}) }),
  strN: (description?: string): S => ({ type: ["string", "null"], ...(description ? { description } : {}) }),
  num: (): S => ({ type: "number" }),
  numN: (): S => ({ type: ["number", "null"] }),
  bool: (): S => ({ type: "boolean" }),
  enumOf: (values: string[]): S => ({ type: "string", enum: values }),
  arr: (items: S, description?: string): S => ({ type: "array", items, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, S>): S => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
};
