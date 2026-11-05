/**
 * Drives a real (headless) Chromium on the employer's official application page.
 * Never bypasses CAPTCHAs or logins: those become "needs you" with the link.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { autoapply } from "@careerflow/core";
import { EXTRACT, FIND_APPLY, FIND_SUBMIT, OPTION_INDEX, OUTCOME, READBACK } from "./page-scripts";

type FormSnapshot = autoapply.FormSnapshot;
type PlannedAnswer = autoapply.PlannedAnswer;

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  dir: string;
}

export async function openSession(): Promise<Session> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const context = await browser.newContext({ userAgent: UA, locale: "en-US", timezoneId: "Asia/Riyadh", viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const dir = await mkdtemp(join(tmpdir(), "cf-apply-"));
  return { browser, context, page, dir };
}

export async function closeSession(s: Session) {
  await s.browser.close().catch(() => undefined);
  await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await sleep(500);
}

async function dismissCookies(page: Page) {
  const btn = page.getByRole("button", { name: /^(accept( all)?( cookies)?|allow all|i agree|agree|got it|ok|موافق|قبول)$/i }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 3000 }).catch(() => undefined);
}

interface RawSnapshot {
  fields: FormSnapshot["fields"];
  captcha: boolean;
  password: boolean;
  title: string;
}

const looksLikeApplication = (fields: FormSnapshot["fields"]) =>
  fields.some((f) => f.type === "file") || (fields.some((f) => f.type === "email" || /e-?mail/i.test(f.label)) && fields.length >= 3);

/** Open the apply link and return the application form, following an "Apply" button if needed. */
export async function openForm(s: Session, url: string, atsKind: string): Promise<{ snapshot: FormSnapshot; page: Page }> {
  let page = s.page;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (err) {
    return { page, snapshot: { url, atsKind, pageTitle: "", fields: [], blockers: [{ kind: "navigation_timeout", detail: String(err).slice(0, 200) }] } };
  }
  await settle(page);
  await dismissCookies(page);

  let raw = (await page.evaluate(EXTRACT)) as RawSnapshot;
  for (let hop = 0; hop < 2 && !looksLikeApplication(raw.fields) && !raw.password && !raw.captcha; hop++) {
    const n = (await page.evaluate(FIND_APPLY)) as number;
    if (!n) break;
    const target = page.locator('[data-cf-apply="0"]');
    const popup = s.context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await target.click({ timeout: 5000 }).catch(() => undefined);
    const newPage = await popup;
    if (newPage) page = newPage;
    await settle(page);
    await dismissCookies(page);
    raw = (await page.evaluate(EXTRACT)) as RawSnapshot;
  }

  const blockers: FormSnapshot["blockers"] = [];
  if (raw.captcha) blockers.push({ kind: "captcha", detail: "CAPTCHA widget on the page" });
  else if (raw.password && !looksLikeApplication(raw.fields)) blockers.push({ kind: "login_required", detail: "Sign-in form shown" });
  else if (!looksLikeApplication(raw.fields)) blockers.push({ kind: "form_missing", detail: `${raw.fields.length} fields, none look like an application form` });
  return { page, snapshot: { url: page.url(), atsKind, pageTitle: raw.title, fields: raw.fields, blockers } };
}

export interface Files {
  cv: { path: string; name: string } | null;
  cover_letter: { path: string; name: string } | null;
}

export async function materialize(s: Session, file: { bytes: Buffer; filename: string } | null) {
  if (!file) return null;
  const name = file.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document.pdf";
  const path = join(s.dir, name);
  await writeFile(path, file.bytes);
  return { path, name };
}

const eqText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Fill every planned answer, then read the form back. Returns the fields that didn't take. */
export async function fill(page: Page, answers: PlannedAnswer[], files: Files): Promise<string[]> {
  const problems: string[] = [];
  for (const a of answers) {
    const loc = page.locator(`[data-cf-key="${a.key.replace(/"/g, '\\"')}"]`);
    try {
      const v = a.value;
      if (v.kind === "file") {
        const f = files[v.doc];
        if (!f) throw new Error("file not available");
        await loc.first().setInputFiles(f.path);
      } else if (a.type === "select" && v.kind === "text") {
        await loc.first().selectOption({ label: v.value });
      } else if ((a.type === "radio" || a.type === "checkbox_group") && (v.kind === "text" || v.kind === "multi")) {
        for (const want of v.kind === "text" ? [v.value] : v.values) {
          const i = (await page.evaluate(`${OPTION_INDEX}(${JSON.stringify([a.key, want])})`)) as number;
          if (i < 0) throw new Error(`option "${want}" not found`);
          await loc.nth(i).check({ force: true });
        }
      } else if (a.type === "checkbox" && v.kind === "bool") {
        if (v.value) await loc.first().check({ force: true });
        else await loc.first().uncheck({ force: true });
      } else if (a.type === "combobox" && v.kind === "text") {
        await loc.first().click();
        await loc.first().fill(v.value);
        await sleep(800);
        await page.keyboard.press("Enter");
      } else if (v.kind === "text") {
        await loc.first().fill(v.value);
      }
    } catch (err) {
      problems.push(`${a.label}: ${(err as Error).message.split("\n")[0]!.slice(0, 120)}`);
    }
  }

  const back = (await page.evaluate(`${READBACK}(${JSON.stringify(answers.map((a) => a.key))})`)) as Record<string, unknown>;
  for (const a of answers) {
    const got = back[a.key];
    const v = a.value;
    let ok = true;
    if (got === null || got === undefined) ok = false;
    else if (v.kind === "file") ok = Array.isArray(got) && got.length > 0;
    else if (v.kind === "bool") ok = got === v.value;
    else if (v.kind === "multi") ok = Array.isArray(got) && v.values.every((x) => (got as string[]).some((g) => eqText(g, x)));
    else if (a.type === "combobox") ok = typeof got === "string" && got.length > 0;
    else if (a.type === "date" || a.type === "tel" || a.type === "number") ok = typeof got === "string" && got.replace(/\D/g, "") === v.value.replace(/\D/g, "") || eqText(String(got), v.value);
    else ok = typeof got === "string" && eqText(got, v.value);
    if (!ok && !problems.some((p) => p.startsWith(`${a.label}:`))) problems.push(`${a.label}: the page didn't keep the value`);
  }
  return problems;
}

export async function screenshot(page: Page) {
  return page.screenshot({ fullPage: true, type: "png", timeout: 20_000 }).catch(() => page.screenshot({ type: "png" }));
}

export interface SubmitResult {
  outcome: "confirmed" | "not_submitted" | "uncertain";
  url: string;
  summary: string;
  errors: string[];
  screenshot: Buffer | null;
}

/**
 * Press Submit once and classify what happened. "not_submitted" is only returned
 * when the form is still there with visible errors (or a challenge), i.e. the
 * employer clearly did not receive it.
 */
export async function submit(page: Page): Promise<SubmitResult> {
  const found = (await page.evaluate(FIND_SUBMIT)) as boolean;
  if (!found) return { outcome: "not_submitted", url: page.url(), summary: "No Submit button found", errors: ["No Submit button found on the form"], screenshot: await screenshot(page).catch(() => null) };
  const before = page.url();
  // Some forms already say "thank you for your interest" above the form; only a change counts.
  const pre = (await page.evaluate(OUTCOME).catch(() => null)) as { confirmed: boolean } | null;
  await page.locator("[data-cf-submit]").first().click({ timeout: 10_000 });

  type Outcome = { confirmed: boolean; confirmation: string; errors: string[]; challenge: boolean; submitStill: boolean };
  let last = null as Outcome | null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    last = (await page.evaluate(OUTCOME).catch(() => null)) as Outcome | null;
    if (!last) continue;
    if (pre?.confirmed && last.confirmed && last.submitStill) last.confirmed = false;
    if (last.confirmed || last.challenge) break;
    if (last.errors.length && last.submitStill && i >= 3) break;
    if (page.url() !== before && i >= 3 && !last.submitStill) break;
  }
  await settle(page);
  const shot = await screenshot(page).catch(() => null);
  const url = page.url();
  if (last?.confirmed) return { outcome: "confirmed", url, summary: last.confirmation || "Confirmation shown", errors: [], screenshot: shot };
  if (last?.challenge) return { outcome: "not_submitted", url, summary: "CAPTCHA challenge", errors: ["The site showed a CAPTCHA challenge"], screenshot: shot };
  if (last && last.submitStill && last.errors.length) return { outcome: "not_submitted", url, summary: "Form showed errors", errors: last.errors, screenshot: shot };
  return { outcome: "uncertain", url, summary: url !== before ? `Moved to ${url}` : "No confirmation shown", errors: [], screenshot: shot };
}
