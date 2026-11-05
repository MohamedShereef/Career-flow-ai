/**
 * Drives a real (headless) Chromium on the employer's official application page.
 * Never bypasses CAPTCHAs or logins: those become "needs you" with the link.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import type { autoapply, fieldMemory } from "@careerflow/core";
import { createHash } from "node:crypto";
type RescueStep = fieldMemory.RescueStep;
import { BOT_CHECK, CHOOSE, ENTER_SAFE, EXTRACT, FIELD_DEBUG, FIND_APPLY, POPUP_ID, SAFE_TARGET, SET_NEARBY_SELECT, SUBMIT_GUARD, WIDGET_SIG, FIND_NAV, FIND_SUBMIT, LISTBOX_OPTIONS, LOGIN_INFO, OUTCOME, READBACK, SET_SELECT } from "./page-scripts";

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
  await context.addInitScript(SUBMIT_GUARD);
  const page = await context.newPage();
  const dir = await mkdtemp(join(tmpdir(), "cf-apply-"));
  return { browser, context, page, dir };
}

/** Turn on the submission guard in the page being filled (it stays off during navigation and sign-in). */
async function armGuard(form: Frame, page: Page) {
  for (const f of new Set([form, page.mainFrame()])) await f.evaluate("window.__cfGuardOn = true").catch(() => undefined);
}

/** Let the next deliberate click submit a form in this frame (sign in, Apply, Next, final Submit). */
async function allowSubmit(scope: Frame | Page, ms = 6000) {
  await scope.evaluate(`window.__cfAllowUntil = Date.now() + ${ms}`).catch(() => undefined);
}

/** Press Enter only where it can't submit a form by accident. */
async function safeEnter(form: Frame, page: Page) {
  const ok = (await form.evaluate(ENTER_SAFE).catch(() => false)) as boolean;
  if (ok) await page.keyboard.press("Enter");
  return ok;
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

const looksLikeApplication = (fields: FormSnapshot["fields"], signedIn = false) =>
  fields.some((f) => f.type === "file") ||
  (fields.some((f) => f.type === "email" || /e-?mail/i.test(f.label)) && fields.length >= 3) ||
  // Inside a candidate portal after sign-in, the first step may only ask for name/phone/country.
  (signedIn && fields.filter((f) => f.type !== "checkbox").length >= 2);

/** Extract from the page and every embedded frame (career sites often embed the ATS form in an iframe). */
async function extractBest(page: Page): Promise<{ frame: Frame; raw: RawSnapshot; frames: number }> {
  const main = page.mainFrame();
  let best = { frame: main, raw: (await main.evaluate(EXTRACT)) as RawSnapshot };
  const frames = page.frames().filter((f) => f !== main && f.url() && !/^about:|recaptcha|hcaptcha|challenges\.cloudflare|googletagmanager|doubleclick|youtube/.test(f.url()));
  if (!looksLikeApplication(best.raw.fields)) {
    for (const f of frames) {
      const raw = (await f.evaluate(EXTRACT).catch(() => null)) as RawSnapshot | null;
      if (raw && looksLikeApplication(raw.fields)) {
        best = { frame: f, raw: { ...raw, captcha: raw.captcha || best.raw.captcha } };
        break;
      }
    }
  }
  return { ...best, frames: frames.length };
}

export interface Credentials {
  username: string;
  password: string;
}
export type LoginLookup = (host: string) => Promise<Credentials | null>;
export type LoginOutcome = "ok" | "failed" | "verification_required" | "no_sign_in";

interface LoginInfo { passwords: number; createMode: boolean; canSwitch: boolean; hasUser: boolean; hasSubmit: boolean; verification: boolean; errors: string[] }

/** Sign in with the user's saved portal account. Switches from "Create account" to "Sign in" when needed. */
export async function signIn(page: Page, cred: Credentials): Promise<{ outcome: LoginOutcome; errors: string[] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let info = (await page.evaluate(LOGIN_INFO)) as LoginInfo;
    if (info.verification && !info.passwords) return { outcome: "verification_required", errors: [] };
    if (!info.passwords) return { outcome: "ok", errors: [] };
    if (info.createMode) {
      if (!info.canSwitch) return { outcome: "no_sign_in", errors: [] };
      await page.locator('[data-cf-login="switch"]').first().click({ timeout: 5000 }).catch(() => undefined);
      await settle(page);
      continue;
    }
    if (info.hasUser) await page.locator('[data-cf-login="user"]').first().fill(cred.username);
    await page.locator('[data-cf-login="pass"]').first().fill(cred.password);
    await allowSubmit(page);
    if (info.hasSubmit) await page.locator('[data-cf-login="submit"]').first().click({ timeout: 8000 });
    else await page.locator('[data-cf-login="pass"]').first().press("Enter");
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      info = (await page.evaluate(LOGIN_INFO).catch(() => null)) as LoginInfo | null ?? info;
      if (info.verification) return { outcome: "verification_required", errors: [] };
      if (!info.passwords) break;
      if (info.errors.length && i >= 1) break; // the portal already said the login is wrong
    }
    await settle(page);
    if (info.verification) return { outcome: "verification_required", errors: [] };
    if (info.passwords && !info.createMode) return { outcome: "failed", errors: info.errors };
    if (!info.passwords) return { outcome: "ok", errors: [] };
  }
  return { outcome: "failed", errors: [] };
}

/** Open each custom dropdown once to learn its options — only from its own list. */
async function readListboxOptions(form: Frame, page: Page, fields: FormSnapshot["fields"]) {
  const opts = async (scope: Frame | Page, popup: string) => ((await scope.evaluate(`${LISTBOX_OPTIONS}(${JSON.stringify(popup || null)})`).catch(() => [])) as string[]);
  for (const f of fields) {
    if (f.type !== "listbox") continue;
    const loc = form.locator(`[data-cf-key="${f.key.replace(/"/g, '\\"')}"]`).first();
    try {
      const popup = ((await form.evaluate(`${POPUP_ID}(${JSON.stringify(f.key)})`).catch(() => "")) as string) || "";
      const before = new Set([...(await opts(form, "")), ...(await opts(page, ""))]);
      await loc.click({ timeout: 4000 });
      await sleep(500);
      let found = popup ? [...(await opts(form, popup)), ...(await opts(page, popup))] : [];
      if (!found.length) found = [...(await opts(form, "")), ...(await opts(page, ""))].filter((o) => !before.has(o)); // only what this click opened
      f.options = [...new Set(found)];
      await page.keyboard.press("Escape");
      await sleep(200);
    } catch {
      f.options = [];
    }
  }
}

export interface OpenResult {
  snapshot: FormSnapshot;
  page: Page;
  form: Frame;
  login?: { host: string; outcome: LoginOutcome };
}

const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };

/** Open the apply link and return the application form: follows "Apply" buttons and signs in with a saved login. */
export async function openForm(s: Session, url: string, atsKind: string, opts: { login?: LoginLookup } = {}): Promise<OpenResult> {
  let page = s.page;
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    status = res?.status() ?? 0;
  } catch (err) {
    return { page, form: page.mainFrame(), snapshot: { url, atsKind, pageTitle: "", fields: [], blockers: [{ kind: "navigation_timeout", detail: String(err).slice(0, 200) }] } };
  }
  await settle(page);
  await dismissCookies(page);

  let found = await extractBest(page);
  // Heavy portals (e.g. SuccessFactors sign-in) render their form a few seconds after load.
  for (let i = 0; i < 3 && !found.raw.fields.length && !found.raw.password; i++) {
    await sleep(2500);
    found = await extractBest(page);
  }
  const visited: string[] = [page.url()];
  let login: OpenResult["login"];
  const isForm = () => looksLikeApplication(found.raw.fields, login?.outcome === "ok" && !found.raw.password);
  for (let hop = 0; hop < 5 && !isForm() && !found.raw.captcha; hop++) {
    if (found.raw.password) {
      const host = hostOf(page.url());
      if (login?.outcome === "ok" && login.host === host) break; // signed in but still a password form: don't loop
      const cred = opts.login ? await opts.login(host) : null;
      if (!cred) {
        login = { host, outcome: "no_sign_in" };
        break;
      }
      const r = await signIn(page, cred);
      login = { host, outcome: r.outcome };
      if (r.outcome !== "ok") break;
      await settle(page);
      found = await extractBest(page);
      for (let i = 0; i < 3 && !found.raw.fields.length; i++) {
        await sleep(2500);
        found = await extractBest(page);
      }
      visited.push(page.url());
      continue;
    }
    const n = (await page.evaluate(FIND_APPLY)) as number;
    if (!n) break;
    const target = page.locator('[data-cf-apply="0"]');
    await allowSubmit(page);
    const popup = s.context.waitForEvent("page", { timeout: 2500 }).catch(() => null);
    await target.click({ timeout: 5000 }).catch(() => undefined);
    const newPage = await popup;
    if (newPage) page = newPage;
    await settle(page);
    await dismissCookies(page);
    found = await extractBest(page);
    for (let i = 0; i < 3 && !found.raw.fields.length && !found.raw.password; i++) {
      await sleep(2500);
      found = await extractBest(page);
    }
    visited.push(page.url());
  }

  const { raw, frame } = found;
  const formAts = frame === page.mainFrame() ? atsKind : (await import("@careerflow/core")).autoapply.atsFromUrl(frame.url());
  const blockers: FormSnapshot["blockers"] = [];
  const where = `pages: ${[...new Set(visited.map(hostOf))].join(" → ")}; title: "${raw.title.slice(0, 80)}"; frames: ${found.frames}; fields: ${raw.fields.length}`;
  const botCheck = !isForm() && ((await page.evaluate(BOT_CHECK).catch(() => false)) as boolean || status === 403 || status === 429);
  if (raw.captcha) blockers.push({ kind: "captcha", detail: `CAPTCHA widget on the page (${where})` });
  else if (login && login.outcome === "failed") blockers.push({ kind: "login_failed", detail: `Sign-in rejected on ${login.host}`, host: login.host });
  else if (login && login.outcome === "verification_required") blockers.push({ kind: "verification_required", detail: `Verification asked on ${login.host}`, host: login.host });
  else if (botCheck) blockers.push({ kind: "captcha", detail: `Robot check / blocked automated access (HTTP ${status || "?"}; ${where})` });
  else if (raw.password && !isForm()) blockers.push({ kind: "login_required", detail: `Sign-in form shown (${where})`, host: hostOf(page.url()) });
  else if (!isForm()) blockers.push({ kind: "form_missing", detail: `No application form found (${where}). Fields seen: ${raw.fields.slice(0, 8).map((f) => f.label || f.type).join(", ")}` });
  if (!blockers.length) await readListboxOptions(frame, page, raw.fields);
  return { page, form: frame, login, snapshot: { url: page.url(), atsKind: formAts, pageTitle: raw.title, fields: raw.fields, blockers } };
}

/** Multi-page forms: what's on the current step? */
export async function readStep(page: Page): Promise<{ form: Frame; fields: FormSnapshot["fields"] }> {
  const found = await extractBest(page);
  await readListboxOptions(found.frame, page, found.raw.fields);
  return { form: found.frame, fields: found.raw.fields };
}

/** Is there a "Next" (another step) or only the final "Submit"? */
export async function navState(form: Frame) {
  return (await form.evaluate(FIND_NAV)) as { next: boolean; submit: boolean };
}

/** Press "Next" and report validation errors if the step didn't advance. */
export async function goNext(form: Frame, page: Page): Promise<{ ok: boolean; errors: string[]; submitted?: { url: string; summary: string; screenshot: Buffer | null } }> {
  const before = (await form.evaluate(EXTRACT)) as RawSnapshot;
  const sig = (r: RawSnapshot) => r.fields.map((f) => f.key).join("|");
  await allowSubmit(form);
  await form.locator("[data-cf-next]").first().click({ timeout: 10_000 });
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const after = (await page.evaluate(OUTCOME).catch(() => null)) as { confirmed: boolean; confirmation: string } | null;
    if (after?.confirmed) {
      // The site treated "Next" as the final submit. Report it truthfully.
      return { ok: false, errors: [], submitted: { url: page.url(), summary: after.confirmation, screenshot: await screenshot(page).catch(() => null) } };
    }
    const now = (await extractBest(page).catch(() => null))?.raw;
    if (now && sig(now) !== sig(before)) return { ok: true, errors: [] };
  }
  const out = (await form.evaluate(OUTCOME).catch(() => null)) as { errors: string[] } | null;
  return { ok: false, errors: out?.errors?.length ? out.errors : ["The form didn't move to the next step"] };
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

const T = { timeout: 6000 };

/** Re-tag fields after the page re-rendered part of the form (keys are deterministic, so they come back the same). */
async function retag(form: Frame) {
  await form.evaluate(EXTRACT).catch(() => undefined);
}

async function pickOption(form: Frame, page: Page, value: string, popupId = "") {
  // Prefer the popup this dropdown says it controls, so we never click another list's option.
  const scopes = popupId ? [form.locator(`[id="${popupId}"]`), page.locator(`[id="${popupId}"]`), page, form] : [page, form];
  for (const scope of scopes) {
    for (const exact of [true, false]) {
      const opt = scope.getByRole("option", { name: value, exact }).first();
      if (await opt.isVisible().catch(() => false)) {
        await opt.click(T);
        return true;
      }
    }
  }
  return false;
}

type Group = "file" | "select" | "choice" | "list" | "text";
const groupOf = (t: PlannedAnswer["type"]): Group =>
  t === "file" ? "file" : t === "select" ? "select" : t === "radio" || t === "checkbox" || t === "checkbox_group" ? "choice" : t === "listbox" || t === "combobox" ? "list" : "text";

interface Ctx {
  form: Frame;
  page: Page;
  a: PlannedAnswer;
  files: Files;
  loc: ReturnType<Frame["locator"]>;
  popup: string;
}
const valueOf = (a: PlannedAnswer) => (a.value.kind === "text" ? a.value.value : "");

/** Every way we know to set a field. Each one only acts; the caller verifies the result. */
const STRATEGIES: Record<string, (c: Ctx) => Promise<void>> = {
  set_files: async ({ loc, a, files }) => {
    if (a.value.kind !== "file") throw new Error("not a file");
    const f = files[a.value.doc];
    if (!f) throw new Error("file not available");
    await loc.first().setInputFiles(f.path, T);
  },
  select_option: async ({ loc, a }) => {
    await loc.first().selectOption({ label: valueOf(a) }, T);
  },
  set_select: async ({ form, a }) => {
    if (!(await form.evaluate(`${SET_SELECT}(${JSON.stringify([a.key, valueOf(a)])})`))) throw new Error(`option "${valueOf(a)}" not in the list`);
  },
  select_keyboard: async ({ form, loc, page, a }) => {
    await loc.first().focus();
    await page.keyboard.type(valueOf(a).slice(0, 12), { delay: 60 });
    await safeEnter(form, page).catch(() => undefined);
    await page.keyboard.press("Tab").catch(() => undefined);
  },
  dom_choose: async ({ form, a }) => {
    const v = a.value;
    const wants: Array<[string, boolean]> = v.kind === "bool" ? [["", v.value]] : v.kind === "multi" ? v.values.map((x) => [x, true]) : [[valueOf(a), true]];
    for (const [want, on] of wants) {
      const r = (await form.evaluate(`${CHOOSE}(${JSON.stringify([a.key, want, on])})`)) as { index: number; checked: boolean };
      if (r.index < 0) throw new Error(`option "${want}" not found`);
    }
  },
  force_check: async ({ form, loc, a }) => {
    const v = a.value;
    if (v.kind === "bool") {
      await (v.value ? loc.first().check({ force: true, ...T }) : loc.first().uncheck({ force: true, ...T }));
      return;
    }
    for (const want of v.kind === "multi" ? v.values : [valueOf(a)]) {
      const r = (await form.evaluate(`${CHOOSE}(${JSON.stringify([a.key, want, true])})`)) as { index: number };
      if (r.index < 0) throw new Error(`option "${want}" not found`);
      await loc.nth(r.index).check({ force: true, ...T });
    }
  },
  click_option: async ({ form, page, loc, a, popup }) => {
    const el = loc.first();
    await el.scrollIntoViewIfNeeded(T).catch(() => undefined);
    await el.click(T).catch(() => el.click({ force: true, ...T }));
    await sleep(400);
    if (!(await pickOption(form, page, valueOf(a), popup))) {
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new Error(`option "${valueOf(a)}" not visible`);
    }
  },
  // Widgets that ignore clicks on options but accept type-ahead on the focused field.
  focus_type_enter: async ({ form, loc, page, a }) => {
    // For type-ahead widgets that aren't text fields (a text field gets type_pick instead).
    if (await loc.first().evaluate((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA")) throw new Error("text field: use type_pick");
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(1200); // let any type-ahead from an earlier attempt expire
    await loc.first().focus();
    await page.keyboard.type(valueOf(a).slice(0, 12), { delay: 60 });
    if (!(await safeEnter(form, page))) throw new Error("Enter not safe here");
  },
  // Searchable lists that load options from the server on real key presses (e.g. SuccessFactors picklists).
  type_pick: async ({ form, page, loc, a, popup }) => {
    const el = loc.first();
    await el.click(T).catch(() => el.click({ force: true, ...T }));
    if (await el.isEditable().catch(() => false)) {
      await el.press("ControlOrMeta+a").catch(() => undefined);
      await el.press("Backspace").catch(() => undefined);
      await el.pressSequentially(valueOf(a), { delay: 90, ...T });
    } else {
      await page.keyboard.type(valueOf(a), { delay: 60 });
    }
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      if (await pickOption(form, page, valueOf(a), popup)) return;
    }
    throw new Error(`"${valueOf(a)}" didn't appear in the list`);
  },
  arrow_enter: async ({ form, loc, page, a }) => {
    const el = loc.first();
    await el.click(T).catch(() => el.click({ force: true, ...T }));
    if (await el.isEditable().catch(() => false)) {
      await el.press("ControlOrMeta+a").catch(() => undefined);
      await el.pressSequentially(valueOf(a), { delay: 90, ...T });
      await sleep(1200);
    } else {
      await page.keyboard.type(valueOf(a).slice(0, 12), { delay: 60 });
    }
    await page.keyboard.press("ArrowDown");
    await sleep(200);
    if (!(await safeEnter(form, page))) throw new Error("no open list to confirm");
  },
  native_nearby: async ({ form, a }) => {
    if (!(await form.evaluate(`${SET_NEARBY_SELECT}(${JSON.stringify([a.key, valueOf(a)])})`))) throw new Error("no native list next to the widget");
  },
  fill: async ({ loc, a }) => {
    await loc.first().fill(valueOf(a), T);
  },
  type_keys: async ({ loc, a }) => {
    const el = loc.first();
    await el.click(T).catch(() => el.click({ force: true, ...T }));
    await el.press("ControlOrMeta+a").catch(() => undefined);
    await el.press("Backspace").catch(() => undefined);
    await el.pressSequentially(valueOf(a), { delay: 40, ...T });
    await el.press("Tab").catch(() => undefined);
  },
};

const DEFAULT_ORDER: Record<Group, string[]> = {
  file: ["set_files"],
  select: ["select_option", "set_select", "select_keyboard"],
  choice: ["dom_choose", "force_check"],
  list: ["click_option", "type_pick", "focus_type_enter", "arrow_enter", "native_nearby"],
  text: ["fill", "type_keys"],
};

/** Run an AI rescue plan, refusing anything outside the field's own widget. */
async function runSteps(c: Ctx, steps: RescueStep[]) {
  const el = c.loc.first();
  for (const st of steps) {
    switch (st.action) {
      case "click_field":
        await el.click(T).catch(() => el.click({ force: true, ...T }));
        break;
      case "click_option":
        if (!(await pickOption(c.form, c.page, valueOf(c.a), c.popup))) throw new Error("option not visible");
        break;
      case "clear_field":
        await el.press("ControlOrMeta+a").catch(() => undefined);
        await el.press("Backspace").catch(() => undefined);
        break;
      case "type_value": {
        const text = st.chars ? valueOf(c.a).slice(0, st.chars) : valueOf(c.a);
        if (await el.isEditable().catch(() => false)) await el.pressSequentially(text, { delay: 80, ...T });
        else await c.page.keyboard.type(text, { delay: 80 });
        break;
      }
      case "press":
        if (st.key === "Enter") {
          if (!(await safeEnter(c.form, c.page))) throw new Error("Enter refused: no open list (could submit the form)");
        } else await c.page.keyboard.press(st.key);
        break;
      case "wait":
        await sleep(st.ms);
        break;
      case "click_css": {
        const ok = (await c.form.evaluate(`${SAFE_TARGET}(${JSON.stringify([c.a.key, st.selector, c.popup])})`).catch(() => false)) as boolean;
        if (!ok) throw new Error("step target outside the field");
        await c.form.locator(st.selector).first().click(T);
        break;
      }
    }
    await sleep(150);
  }
}

export interface FillMemory {
  /** Learned methods for a widget on this site, best first ("ai" entries carry steps). */
  order(signature: string, group: string): Promise<Array<{ strategy: string; steps: RescueStep[] | null }>>;
  record(signature: string, group: string, strategy: string, ok: boolean, steps?: RescueStep[] | null): Promise<void>;
  /** Ask the AI for a plan when every known method failed. */
  rescue?(info: { label: string; wanted: string; fieldType: string; html: string; pageValue: string; tried: string[] }): Promise<RescueStep[] | null>;
}

type Attempt = { method: string; error?: string; after?: string };
class FillError extends Error {
  constructor(message: string, readonly attempts: Attempt[]) {
    super(message);
  }
}

async function fillOne(form: Frame, page: Page, a: PlannedAnswer, files: Files, memory?: FillMemory, allowRescue = false) {
  let loc = form.locator(`[data-cf-key="${a.key.replace(/"/g, '\\"')}"]`);
  if (!(await loc.count())) {
    await retag(form);
    loc = form.locator(`[data-cf-key="${a.key.replace(/"/g, '\\"')}"]`);
    if (!(await loc.count())) throw new Error("field disappeared from the page");
  }
  const popup = ((await form.evaluate(`${POPUP_ID}(${JSON.stringify(a.key)})`).catch(() => "")) as string) || "";
  const c: Ctx = { form, page, a, files, loc, popup };
  const group = groupOf(a.type);
  const sig = ((await form.evaluate(`${WIDGET_SIG}(${JSON.stringify(a.key)})`).catch(() => "")) as string) || `${group}:unknown`;

  const learned = memory ? await memory.order(sig, group).catch(() => []) : [];
  const plan: Array<{ strategy: string; steps: RescueStep[] | null }> = [...learned];
  for (const st of DEFAULT_ORDER[group]) if (!plan.some((p) => p.strategy === st)) plan.push({ strategy: st, steps: null });

  const tried: string[] = [];
  const attempts: Attempt[] = [];
  const pageValue = async () => {
    const back = (await form.evaluate(`${READBACK}(${JSON.stringify([a.key])})`).catch(() => ({}))) as Record<string, unknown>;
    return JSON.stringify(back[a.key] ?? null).slice(0, 80);
  };
  let lastError = "";
  for (const p of plan) {
    const run = p.steps ? () => runSteps(c, p.steps!) : STRATEGIES[p.strategy];
    if (!run) continue;
    tried.push(p.strategy);
    const at: Attempt = { method: p.strategy };
    attempts.push(at);
    try {
      await run(c);
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0]!.slice(0, 120);
      at.error = lastError;
    }
    await sleep(300);
    // Picklists only commit (or reset) when you leave the field, so judge them after leaving it.
    if (group === "list") {
      await form.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => undefined);
      await sleep(400);
    }
    if (await keeps(form, a)) {
      await memory?.record(sig, group, p.strategy, true, p.steps).catch(() => undefined);
      return;
    }
    at.after = await pageValue();
    await memory?.record(sig, group, p.strategy, false, p.steps).catch(() => undefined);
    if (group === "file") break;
  }

  // Every known method failed: let the AI propose a plan from the safe action set (once per field).
  if (allowRescue && memory?.rescue && group !== "file" && a.value.kind === "text") {
    const dbg = (await form.evaluate(`${FIELD_DEBUG}(${JSON.stringify(a.key)})`).catch(() => null)) as { html?: string; value?: unknown } | null;
    const steps = await memory.rescue({ label: a.label, wanted: valueOf(a), fieldType: a.type, html: dbg?.html ?? "", pageValue: String(dbg?.value ?? ""), tried }).catch(() => null);
    if (steps?.length) {
      try {
        await runSteps(c, steps);
      } catch (err) {
        lastError = `AI rescue: ${(err as Error).message.slice(0, 100)}`;
      }
      await form.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => undefined);
      await sleep(400);
      const ok = await keeps(form, a);
      const name = `ai:${createHash("sha1").update(JSON.stringify(steps)).digest("hex").slice(0, 10)}`;
      await memory.record(sig, group, name, ok, steps).catch(() => undefined);
      if (ok) return;
      lastError ||= "AI rescue didn't work";
    }
  }
  throw new FillError(lastError || "the page didn't keep the value", attempts);
}

async function keeps(form: Frame, a: PlannedAnswer) {
  const back = (await form.evaluate(`${READBACK}(${JSON.stringify([a.key])})`).catch(() => ({}))) as Record<string, unknown>;
  return kept(a, back[a.key]);
}

function kept(a: PlannedAnswer, got: unknown) {
  const v = a.value;
  if (got === null || got === undefined) return false;
  if (v.kind === "file") return Array.isArray(got) && got.length > 0;
  if (v.kind === "bool") return got === v.value;
  if (v.kind === "multi") return Array.isArray(got) && v.values.every((x) => (got as string[]).some((g) => eqText(g, x)));
  const g = String(got);
  if (a.type === "combobox" || a.type === "listbox") return eqText(g, v.value) || g.toLowerCase().includes(v.value.toLowerCase().slice(0, 30));
  if (a.type === "date" || a.type === "tel" || a.type === "number") return g.replace(/\D/g, "") === v.value.replace(/\D/g, "") || eqText(g, v.value);
  if (a.type === "radio" || a.type === "select") return eqText(g, v.value) || g.toLowerCase().startsWith(v.value.toLowerCase());
  return eqText(g, v.value);
}

export interface FillResult {
  /** Fields that could not be set (with the reason). Required ones block the application. */
  problems: Array<{ key: string; label: string; reason: string; required: boolean; wanted?: string; debug?: unknown }>;
}

/**
 * Fill every planned answer in page order, read the form back, and re-fill anything the
 * page reset (cascading fields re-render the form). Two passes, then report what didn't stick.
 */
export async function fill(form: Frame, page: Page, answers: PlannedAnswer[], files: Files, required?: Set<string>, memory?: FillMemory): Promise<FillResult> {
  await armGuard(form, page);
  const errors = new Map<string, string>();
  const attemptsByKey = new Map<string, Attempt[]>();
  const pass = async (list: PlannedAnswer[], rescue = false) => {
    for (const a of list) {
      try {
        await fillOne(form, page, a, files, memory, rescue);
        errors.delete(a.key);
      } catch (err) {
        errors.set(a.key, (err as Error).message.split("\n")[0]!.slice(0, 120));
        if (err instanceof FillError) attemptsByKey.set(a.key, [...(attemptsByKey.get(a.key) ?? []), ...err.attempts]);
      }
    }
  };
  const readBack = async () => {
    await retag(form);
    return (await form.evaluate(`${READBACK}(${JSON.stringify(answers.map((a) => a.key))})`)) as Record<string, unknown>;
  };

  await pass(answers);
  await sleep(1000);
  let back = await readBack();
  const again = answers.filter((a) => !kept(a, back[a.key]));
  if (again.length) {
    await pass(again, true); // second pass: the AI may try to rescue fields that still fail
    await sleep(800);
    back = await readBack();
  }
  const problems: FillResult["problems"] = [];
  for (const a of answers) {
    if (kept(a, back[a.key])) continue;
    const debug = await form.evaluate(`${FIELD_DEBUG}(${JSON.stringify(a.key)})`).catch(() => null);
    const wanted = a.value.kind === "text" ? a.value.value : a.value.kind === "multi" ? a.value.values.join("; ") : a.value.kind === "bool" ? String(a.value.value) : a.value.doc;
    const blocked = (await form.evaluate("window.__cfBlocked || 0").catch(() => 0)) as number;
    problems.push({ key: a.key, label: a.label, reason: errors.get(a.key) ?? `the page didn't keep the value (wanted "${wanted.slice(0, 60)}", page shows "${String(back[a.key] ?? "").slice(0, 60)}")`, required: required ? required.has(a.key) : true, wanted, debug: { ...(debug as object | null ?? {}), attempts: attemptsByKey.get(a.key) ?? [], blockedSubmits: blocked } });
  }
  return { problems };
}

export const describeProblems = (p: FillResult["problems"]) => p.map((x) => `${x.label}: ${x.reason}`).join(" | ");

export async function screenshot(page: Page) {
  return page.screenshot({ fullPage: true, type: "png", timeout: 20_000 }).catch(() => page.screenshot({ type: "png" }));
}

export interface SubmitResult {
  /** Fields the form flagged after Submit (label, message, our key when known). */
  invalid?: Array<{ key: string | null; label: string; message: string }>;
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
export async function submit(form: Frame, page: Page): Promise<SubmitResult> {
  const found = (await form.evaluate(FIND_SUBMIT)) as boolean;
  if (!found) return { outcome: "not_submitted", url: page.url(), summary: "No Submit button found", errors: ["No Submit button found on the form"], screenshot: await screenshot(page).catch(() => null) };
  const before = page.url();
  // Some forms already say "thank you for your interest" above the form; only a change counts.
  const pre = (await form.evaluate(OUTCOME).catch(() => null)) as { confirmed: boolean } | null;
  await allowSubmit(form, 15_000);
  await form.locator("[data-cf-submit]").first().click({ timeout: 10_000 });

  type Outcome = { confirmed: boolean; confirmation: string; errors: string[]; challenge: boolean; submitStill: boolean; invalid?: Array<{ key: string | null; label: string; message: string }> };
  let last = null as Outcome | null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    last = (await form.evaluate(OUTCOME).catch(() => null)) as Outcome | null;
    // The confirmation may appear on the outer page instead of inside the embedded form.
    if (form !== page.mainFrame() && !last?.confirmed) {
      const outer = (await page.evaluate(OUTCOME).catch(() => null)) as Outcome | null;
      if (outer?.confirmed) last = { ...outer, submitStill: last?.submitStill ?? false };
    }
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
  if (last && last.submitStill && (last.errors.length || last.invalid?.length)) {
    const detailed = (last.invalid ?? []).map((f) => `${f.label || "a field"}${f.message ? `: ${f.message}` : ""}`);
    const errors = [...new Set([...detailed, ...last.errors.filter((e) => !detailed.length || !/correct the errors/i.test(e))])].slice(0, 8);
    return { outcome: "not_submitted", url, summary: "Form showed errors", errors, invalid: last.invalid ?? [], screenshot: shot };
  }
  return { outcome: "uncertain", url, summary: url !== before ? `Moved to ${url}` : "No confirmation shown", errors: [], screenshot: shot };
}
