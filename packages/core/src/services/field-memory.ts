/**
 * Self-learning for form filling.
 *
 * 1. Site memory: for each site + kind of widget, which fill method worked. The best one is tried
 *    first next time. Shared across users because it describes the site, not anyone's answers.
 * 2. AI rescue: when every known method fails, the AI proposes a short plan from a fixed, safe
 *    set of actions (click the field, click an option, type the value, press a navigation key,
 *    wait). The worker validates and runs it; if it works it becomes a remembered method.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { fieldRecipes } from "@careerflow/db";
import { js, structured } from "../ai";
import type { Db, Executor } from "../types";

export type RescueStep =
  | { action: "click_field" }
  | { action: "click_option" }
  | { action: "type_value"; chars?: number | null }
  | { action: "clear_field" }
  | { action: "press"; key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape" | "Space" | "Backspace" | "Home" | "End" }
  | { action: "click_css"; selector: string }
  | { action: "wait"; ms: number };

const KEYS = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape", "Space", "Backspace", "Home", "End"] as const;

/** Learned methods for this widget on this site, best first. */
export async function learnedOrder(db: Executor, host: string, signature: string) {
  const rows = await db
    .select()
    .from(fieldRecipes)
    .where(and(eq(fieldRecipes.host, host), eq(fieldRecipes.signature, signature), sql`${fieldRecipes.successes} > 0`))
    .orderBy(desc(sql`${fieldRecipes.successes} - ${fieldRecipes.failures} * 2`), desc(fieldRecipes.lastSuccessAt))
    .limit(6);
  return rows.filter((r) => r.successes > r.failures * 2 || r.failures < 3).map((r) => ({ strategy: r.strategy, steps: (r.steps as RescueStep[] | null) ?? null }));
}

export async function record(db: Executor, host: string, signature: string, fieldGroup: string, strategy: string, ok: boolean, steps?: RescueStep[] | null) {
  const now = new Date();
  await db
    .insert(fieldRecipes)
    .values({ host, signature, fieldGroup, strategy, steps: steps ?? null, successes: ok ? 1 : 0, failures: ok ? 0 : 1, lastSuccessAt: ok ? now : null, lastFailureAt: ok ? null : now })
    .onConflictDoUpdate({
      target: [fieldRecipes.host, fieldRecipes.signature, fieldRecipes.strategy],
      set: ok
        ? { successes: sql`${fieldRecipes.successes} + 1`, lastSuccessAt: now }
        : { failures: sql`${fieldRecipes.failures} + 1`, lastFailureAt: now },
    });
}

/** Keep AI plans safe: known actions only, a single CSS selector without anything that could navigate. */
export function sanitizeSteps(raw: unknown): RescueStep[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) return null;
  const out: RescueStep[] = [];
  for (const s of raw as Array<Record<string, unknown>>) {
    switch (s.action) {
      case "click_field":
      case "click_option":
      case "clear_field":
        out.push({ action: s.action });
        break;
      case "type_value":
        out.push({ action: "type_value", chars: typeof s.chars === "number" && s.chars > 0 ? Math.min(40, Math.floor(s.chars)) : null });
        break;
      case "press":
        if (!KEYS.includes(s.key as (typeof KEYS)[number])) return null;
        out.push({ action: "press", key: s.key as (typeof KEYS)[number] });
        break;
      case "wait":
        out.push({ action: "wait", ms: Math.max(100, Math.min(3000, Number(s.ms) || 500)) });
        break;
      case "click_css": {
        const sel = String(s.selector ?? "").trim();
        if (!sel || sel.length > 200 || /[<>{}]|javascript:|\bhref\b|submit|form\b|\bnext\b|continue|apply|save|delete|remove/i.test(sel)) return null;
        out.push({ action: "click_css", selector: sel });
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

const SCHEMA = js.obj({
  steps: js.arr(
    js.obj({
      action: js.enumOf(["click_field", "click_option", "type_value", "clear_field", "press", "click_css", "wait"]),
      key: js.strN("For press: ArrowDown, ArrowUp, Enter, Tab, Escape, Space, Backspace, Home or End"),
      selector: js.strN("For click_css: a CSS selector for an element inside this field's widget or its option list"),
      chars: js.numN(),
      ms: js.numN(),
    }),
  ),
  reason: js.str("One sentence: why these steps should work for this widget"),
});

const SYSTEM = `You help a browser agent set ONE form field to a given value on a job-application page.
You get the field's HTML, its label, the value to set, and what was already tried.
Return 1-8 steps using only these actions:
- click_field: click the field itself
- click_option: click the visible list option whose text matches the value
- type_value: type the value with real key presses (set chars to type only the first N characters, else null)
- clear_field: select all and delete in the field
- press: one key from ArrowDown, ArrowUp, Enter, Tab, Escape, Space, Backspace, Home, End
- click_css: click an element inside this field's widget or its option list (never buttons that submit, navigate or move to another step)
- wait: pause (set ms)
Never try to submit the form, change other fields, or navigate. If you can't tell, return the most common pattern for this kind of widget.`;

export async function rescuePlan(
  db: Db,
  userId: string,
  info: { host: string; label: string; wanted: string; fieldType: string; html: string; pageValue: string; tried: string[] },
) {
  const { data } = await structured<{ steps: unknown[]; reason: string }>({
    db,
    userId,
    stage: "field_rescue",
    agent: "application",
    inputSummary: `${info.host} · ${info.label}`,
    system: SYSTEM,
    user: `Site: ${info.host}\nField label: ${info.label}\nField type as detected: ${info.fieldType}\nValue to set: ${info.wanted}\nThe page currently shows: ${info.pageValue}\nAlready tried (all failed): ${info.tried.join(", ")}\n\nField HTML:\n"""\n${info.html.slice(0, 3500)}\n"""`,
    schemaName: "field_rescue",
    schema: SCHEMA,
    maxOutputTokens: 800,
    outcome: (d) => `${d.steps.length} steps`,
  });
  // Drop null fields the schema allows so sanitizing sees only what each action uses.
  const steps = data.steps.map((s) => Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([, v]) => v !== null)));
  return sanitizeSteps(steps);
}

export async function stats(db: Executor) {
  const [r] = await db
    .select({ methods: sql<number>`count(*) filter (where ${fieldRecipes.successes} > 0)::int`, aiFound: sql<number>`count(*) filter (where ${fieldRecipes.steps} is not null and ${fieldRecipes.successes} > 0)::int`, sites: sql<number>`count(distinct ${fieldRecipes.host})::int` })
    .from(fieldRecipes);
  return r ?? { methods: 0, aiFound: 0, sites: 0 };
}
