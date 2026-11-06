// Real-browser smoke test against a running app: `BASE_URL=http://localhost:3000 node test/e2e/smoke.mjs`
// Uses the system Chrome (CHROME_PATH) or Playwright's Chromium.
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "/tmp/cf-shots";
mkdirSync(OUT, { recursive: true });
const email = `e2e-${Date.now()}@example.com`;
const pw = "e2e password 123";

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  await fn();
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("✓", name);
};
const expectText = async (text) => {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 10_000 });
};

await step("01-signup", async () => {
  await page.goto(`${BASE}/signup`);
  await page.fill('input[name="name"]', "Mohamed Test");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/profile/);
  await expectText("Welcome!");
});

await step("02-personal", async () => {
  await page.fill('input[name="phone"]', "+966 50 123 4567");
  await page.fill('input[name="nationality"]', "Egyptian");
  await page.fill('input[name="residencyCountry"]', "Saudi Arabia");
  await page.fill('input[name="noticePeriodDays"]', "60");
  await page.fill('input[name="expectedSalary"]', "30000");
  await page.click('button:has-text("Save personal details")');
  await expectText("Personal details saved.");
});

await step("03-preferences", async () => {
  await page.goto(`${BASE}/profile?tab=preferences`);
  await page.fill('textarea[name="preferredTitles"]', "Senior Procurement Engineer\nProcurement Manager");
  await page.fill('textarea[name="preferredLocations"]', "Riyadh\nJeddah");
  await page.click('button:has-text("Save preferences")');
  await expectText("Job preferences saved.");
});

await step("04-experience", async () => {
  await page.goto(`${BASE}/profile?tab=experience`);
  const form = page.locator("aside, .lg\\:col-span-2").last();
  await form.locator('input[name="title"]').fill("Senior Materials & Procurement Engineer");
  await form.locator('input[name="employer"]').fill("Example Contracting Co.");
  await form.locator('input[name="startDate"]').fill("2017-10");
  await form.locator('input[name="isCurrent"]').check();
  await form.locator('button:has-text("Add experience")').click();
  await expectText("Experience saved.");
  await page.reload();
  await expectText("Example Contracting Co.");
});

await step("05-highlight-verify", async () => {
  await page.goto(`${BASE}/profile?tab=highlights`);
  await page.selectOption('select[name="category"]', "contract_value");
  await page.fill('textarea[name="statement"]', "Negotiated a subcontract package worth SAR 60M individually.");
  await page.fill('input[name="numericValue"]', "60000000");
  await page.fill('input[name="unit"]', "SAR");
  await page.click('button:has-text("Save as draft")');
  await expectText("Needs verification");
  await page.fill('.card input[name="meaning"]', "Value of one contract I negotiated individually");
  await page.click('button:has-text("I confirm this is accurate")');
  await page.locator("span", { hasText: /^Verified$/ }).first().waitFor({ timeout: 10_000 });
});

await step("06-upload-cv", async () => {
  await page.goto(`${BASE}/profile?tab=documents`);
  writeFileSync("/tmp/cv.pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  await page.setInputFiles('input[type="file"]', "/tmp/cv.pdf");
  await page.click('button:has-text("Upload")');
  await expectText("Uploaded");
  await page.reload();
  await expectText("Main CV");
  const href = await page.locator('a[href^="/api/documents/"]').first().getAttribute("href");
  const res = await page.request.get(`${BASE}${href}`);
  if (res.status() !== 200 || !(await res.text()).startsWith("%PDF")) throw new Error("CV download failed");
});

await step("07-saved-answer", async () => {
  await page.goto(`${BASE}/profile?tab=answers`);
  await page.fill('textarea[name="questionText"]', "Have you ever been convicted of a criminal offence?");
  await page.fill('textarea[name="answer"]', "No");
  await page.click('button:has-text("Save answer")');
  await expectText("You review before each submit");
});

await step("08-home", async () => {
  await page.goto(`${BASE}/home`);
  await expectText("Welcome, Mohamed");
  await expectText("Online");
});

await step("09-settings-limits", async () => {
  await page.goto(`${BASE}/settings`);
  if ((await page.inputValue('select[name="dailyLimitsEnabled"]')) !== "off") throw new Error("daily limits should be off by default");
  await page.fill('input[name="maxSubmissionsPerDay"]', "51");
  await page.evaluate(() => document.querySelectorAll("input").forEach((i) => i.removeAttribute("max")));
  await page.click('button:has-text("Save limits")');
  await expectText("less than or equal to 50"); // the server still enforces the ceiling when limits are on
  await page.goto(`${BASE}/settings?tab=diagnostics`);
  await expectText("Workers");
});

await step("10-logout-login", async () => {
  await page.goto(`${BASE}/home`);
  await page.click('button:has-text("Sign out")');
  await page.waitForURL(/\/login/);
  await page.goto(`${BASE}/profile`);
  await page.waitForURL(/\/login\?next=/);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "wrong password 1");
  await page.click('button[type="submit"]');
  await expectText("Email or password is incorrect.");
  await page.fill('input[name="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/profile/);
});

// Cross-user isolation through the real HTTP surface.
await step("11-isolation", async () => {
  const href = await (async () => {
    await page.goto(`${BASE}/profile?tab=documents`);
    return page.locator('a[href^="/api/documents/"]').first().getAttribute("href");
  })();
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(`${BASE}/signup`);
  await p2.fill('input[name="name"]', "Other User");
  await p2.fill('input[name="email"]', `other-${Date.now()}@example.com`);
  await p2.fill('input[name="password"]', pw);
  await p2.click('button[type="submit"]');
  await p2.waitForURL(/\/profile/);
  const res = await p2.request.get(`${BASE}${href}`);
  if (res.status() !== 404) throw new Error(`Other user got ${res.status()} for someone else's CV`);
  await other.close();
});

await browser.close();
if (errors.length) {
  console.error("Page errors:", errors);
  process.exit(1);
}
console.log("E2E smoke passed");
