// Real-browser test of CV import + tailoring against a running app wired to an AI (or the mock in test/e2e/mock-openai.mjs).
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const CV = process.env.CV_PATH ?? "/tmp/real-cv.pdf";
const OUT = process.env.SHOT_DIR ?? "/tmp/cf-shots";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const see = (t) => page.getByText(t, { exact: false }).first().waitFor({ timeout: 90_000 });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

await page.goto(`${BASE}/signup`);
await page.fill('input[name="name"]', "Mohamed Test");
await page.fill('input[name="email"]', `cv-${Date.now()}@example.com`);
await page.fill('input[name="password"]', "e2e password 123");
await page.click('button[type="submit"]');
await page.waitForURL(/\/profile/);

await page.goto(`${BASE}/profile?tab=documents`);
await page.setInputFiles('input[type="file"]', CV);
await page.click('button:has-text("Upload")');
// Upload reads the CV automatically and opens the review page.
await page.waitForURL(/\/profile\/import\//, { timeout: 120_000 });
await see("Review what we read from your CV");
await shot("20-import-review");
console.log("✓ CV read and review page shown");

await page.click('button:has-text("Add to my profile")');
await see("Added");
await shot("21-import-applied");
console.log("✓", (await page.locator('[role="status"]').first().innerText()).slice(0, 160));

await page.goto(`${BASE}/profile?tab=experience`);
await see("Example Contracting Co.");
await page.goto(`${BASE}/profile?tab=qualifications`);
await see("In progress");
console.log("✓ experience + in-progress CIPS on profile");

await page.goto(`${BASE}/jobs?tab=tailor`);
await page.fill('input[name="jobTitle"]', "Senior Procurement Engineer");
await page.fill('input[name="companyName"]', "Acme Giga Projects");
await page.fill(
  'textarea[name="jobDescription"]',
  "We are hiring a Senior Procurement Engineer for MEP packages on a giga-project in Riyadh. Run tenders, negotiate subcontracts, manage suppliers. Requirements: 8+ years, PMP or CIPS, SAP.",
);
await page.click('button:has-text("Create tailored CV")');
await page.waitForURL(/\/jobs\/tailored\//, { timeout: 120_000 });
await see("Removed by the fact check");
await see("SAR 900M");
await shot("22-tailored");
const href = await page.locator('a:has-text("Download CV (PDF)")').getAttribute("href");
const pdf = await page.request.get(`${BASE}${href}`);
if (pdf.status() !== 200 || !(await pdf.body()).subarray(0, 5).toString().startsWith("%PDF")) throw new Error("tailored CV download failed");
await page.click('button:has-text("approve this version")');
await see("Approved");
console.log("✓ tailored CV created, guard removed invented figure, PDF downloads, approval works");

await browser.close();
if (errors.length) {
  console.error(errors);
  process.exit(1);
}
console.log("CV flow passed");
