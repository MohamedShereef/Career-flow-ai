// Real-browser test of auto-apply through the UI: tailor → consent → fill → answer once → approve → submitted.
// Needs the app, the worker, and test/e2e/mock-openai.mjs (mock AI on 4010, mock employer form on 4011).
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "/tmp/cf-shots";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const see = (t, timeout = 90_000) => page.getByText(t, { exact: false }).first().waitFor({ timeout });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
async function waitOnPage(url, text, timeout = 150_000) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) return;
    if (Date.now() > end) { await shot("fail"); throw new Error(`timed out waiting for "${text}" on ${url}`); }
    await page.waitForTimeout(3000);
  }
}

await page.goto(`${BASE}/signup`);
await page.fill('input[name="name"]', "Mohamed Apply");
await page.fill('input[name="email"]', `apply-${Date.now()}@example.com`);
await page.fill('input[name="password"]', "e2e password 123");
await page.click('button[type="submit"]');
await page.waitForURL(/\/profile/);

// Profile from the CV (the mock AI reads it)
await page.goto(`${BASE}/profile?tab=documents`);
await page.setInputFiles('input[type="file"]', process.env.CV_PATH ?? "/tmp/real-cv.pdf");
await page.click('button:has-text("Upload")');
await page.waitForURL(/\/profile\/import\//, { timeout: 120_000 });
await page.click('button:has-text("Add to my profile")');
await see("Added");
console.log("✓ profile filled from CV");

await page.goto(`${BASE}/settings?tab=consent`);
await page.locator("li", { hasText: "Fill and submit applications" }).getByRole("button", { name: "Allow" }).click();
await see("Granted");
console.log("✓ consent granted");

await page.goto(`${BASE}/jobs?tab=tailor`);
await page.fill('input[name="jobTitle"]', "Senior Procurement Engineer");
await page.fill('input[name="companyName"]', "Acme Giga Projects");
await page.fill('textarea[name="jobDescription"]', "Senior Procurement Engineer for MEP packages on a giga-project in Riyadh. Run tenders, negotiate subcontracts. 8+ years, PMP or CIPS.");
await page.click('button:has-text("Create tailored CV")');
await page.waitForURL(/\/jobs\/tailored\//, { timeout: 120_000 });
await page.click('button:has-text("approve this version")');
await see("Approved");
await page.fill('input[name="applyUrl"]', "http://localhost:4011/ats/apply");
await page.click('button:has-text("Save link")');
await see("Fill the application for me");
await page.click('button:has-text("Fill the application for me")');
await page.waitForURL(/\/applications\/[0-9a-f-]{36}$/, { timeout: 60_000 });
const appUrl = page.url();
console.log("✓ auto-apply started");

await waitOnPage(appUrl, "question for you");
await shot("30-apply-question");
console.log("✓ work-authorisation question sent to the inbox (not guessed)");
await page.goto(`${BASE}/profile?tab=questions`);
await page.locator(".card", { hasText: "legally authorized" }).locator('select[name="answer"]').selectOption("Yes");
await page.locator(".card", { hasText: "legally authorized" }).getByRole("button", { name: "Save & continue" }).click();
await page.locator(".card", { hasText: "legally authorized" }).waitFor({ state: "detached", timeout: 30_000 });

await waitOnPage(appUrl, "Approve & submit");
await see("Your saved answer");
await see("Written by AI");
await shot("31-apply-preview");
let r = await (await fetch("http://localhost:4011/ats/received")).json();
if (r.length !== 0) throw new Error("something was sent before approval");
console.log("✓ preview shown with sources; nothing sent before approval");

await page.click('button:has-text("Approve & submit")');
await see("Approved");
await waitOnPage(appUrl, "The employer's site confirmed");
await shot("32-apply-submitted");
r = await (await fetch("http://localhost:4011/ats/received")).json();
if (r.length !== 1) throw new Error(`expected exactly one submission, got ${r.length}`);
console.log("✓ submitted exactly once, confirmation captured as evidence");

await page.goto(`${BASE}/applications`);
await see("Submitted");
await browser.close();
if (errors.length) {
  console.error(errors);
  process.exit(1);
}
console.log("Apply flow passed");
