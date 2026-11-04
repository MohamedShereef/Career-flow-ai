// Browser test: preferences → add a job board (mock SuccessFactors at :4011) → test → add → worker discovers and AI scores → Jobs page.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BOARD = process.env.MOCK_BOARD ?? "http://localhost:4011";
const OUT = process.env.SHOT_DIR ?? "/tmp/cf-shots";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const see = (t, timeout = 30_000) => page.getByText(t, { exact: false }).first().waitFor({ timeout });

await page.goto(`${BASE}/signup`);
await page.fill('input[name="name"]', "Mohamed Test");
await page.fill('input[name="email"]', `disc-${Date.now()}@example.com`);
await page.fill('input[name="password"]', "e2e password 123");
await page.click('button[type="submit"]');
await page.waitForURL(/\/profile/);

await page.goto(`${BASE}/profile?tab=preferences`);
await page.fill('textarea[name="preferredTitles"]', "Senior Procurement Engineer");
await page.click('button:has-text("Save preferences")');
await see("Job preferences saved.");
console.log("✓ preferences saved (employer rules default: no subcontractors, large only, prefer PIF)");

await page.goto(`${BASE}/settings?tab=sources`);
await page.selectOption('select[name="kind"]', "successfactors");
await page.fill('input[name="name"]', "Mock Giga Developer");
await page.fill('input[name="identifier"]', BOARD);
await page.click('button:has-text("Test")');
await see("procurement-family");
console.log("✓", (await page.locator('[role="status"]').first().innerText()).slice(0, 140));
await page.click('button:has-text("Add source")');
await page.getByText(/Added\.|already being watched/).first().waitFor({ timeout: 30_000 });
console.log("✓ source added (or already present)");
await page.goto(`${BASE}/jobs`);
await page.click('button:has-text("Find new jobs now")');
await see("Searching all job boards now");
console.log("✓ manual discovery started; waiting for worker to discover and score…");

let found = false;
for (let i = 0; i < 40 && !found; i++) {
  await page.waitForTimeout(3000);
  await page.goto(`${BASE}/jobs?tab=recommended`);
  found = (await page.getByText("Senior Procurement Engineer - MEP").count()) > 0;
}
if (!found) throw new Error("recommended job never appeared");
await page.screenshot({ path: `${OUT}/30-jobs.png`, fullPage: true });
console.log("✓ recommended job appeared");

await page.goto(`${BASE}/jobs?tab=rejected`);
await see("Procurement Officer");
if ((await page.getByText("Quantity Surveyor").count()) > 0) throw new Error("non-procurement role should have been filtered out");
console.log("✓ weak match rejected with reason; Quantity Surveyor never kept");

await page.goto(`${BASE}/jobs?tab=recommended`);
await page.click('text=Senior Procurement Engineer - MEP');
await see("Employer check");
await see("PIF company");
await page.screenshot({ path: `${OUT}/31-job-detail.png`, fullPage: true });
console.log("✓ job detail with score breakdown and employer check");

await browser.close();
if (errors.length) {
  console.error(errors);
  process.exit(1);
}
console.log("Discovery flow passed");
