/**
 * The Chrome extension's filler, run in a real browser on the Workable-style form: it must fill
 * every answer the user reviewed, attach the CV, never press Submit, and report "sent" only when
 * the user says so (or the page confirms).
 */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { EXTRACT } from "../src/apply/page-scripts";
import { WORKABLE_HTML } from "./workable-mock";

const chrome = process.env.CHROME_PATH;
const run = chrome && existsSync(chrome) ? describe : describe.skip;
let browser: Browser;

run("Chrome extension filler", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
  });
  afterAll(async () => browser?.close());

  it("fills a Workable-style form with the reviewed answers, attaches the CV, and leaves Submit to the user", async () => {
    const page = await browser.newPage();
    let submitted = false;
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: WORKABLE_HTML }));
    await page.goto("https://apply.example.test/qiddiya/j/CC974086D8/apply");
    page.on("request", (r) => { if (r.method() === "POST") submitted = true; });
    await page.addScriptTag({ content: `window.__cfExtract = () => ${EXTRACT.trim()};` });
    await page.addScriptTag({ content: readFileSync(new URL("../../../extension/src/filler.js", import.meta.url), "utf8") });

    const pdf = Buffer.from("%PDF-1.4\n% CareerFlow test CV\n").toString("base64");
    const data = {
      applicationId: "11111111-1111-1111-1111-111111111111", jobTitle: "Procurement Governance & Reporting", company: "Qiddiya", version: 1,
      answers: [
        { key: "text:firstname", label: "First name", type: "text", value: "MOHAMED" },
        { key: "email:email", label: "Email", type: "email", value: "m@example.com" },
        { key: "tel:phone", label: "Phone", type: "tel", value: "+966 50 000 0000" },
        { key: "text:address", label: "Address", type: "text", value: "Riyadh, Saudi Arabia" },
        { key: "text:ca_36432", label: "Expected Salary", type: "text", value: "25000" },
        { key: "text:ca_50967", label: "Are you willing to relocate within Saudi Arabia?", type: "text", value: "Yes" },
        { key: "combobox:input_ca_50968_input", label: "Do you hold a valid Saudi Iqama?", type: "combobox", value: "Yes" },
        { key: "file:resume", label: "Resume", type: "file", value: null, file: [{ documentId: "doc-cv", filename: "Mohamed_CV.pdf" }] },
      ],
    };
    const result = await page.evaluate(async ([d, files]) => {
      (window as unknown as { __reports: unknown[] }).__reports = [];
      return (window as unknown as { __cfFill: Function }).__cfFill(d, files, (m: unknown) => (window as unknown as { __reports: unknown[] }).__reports.push(m));
    }, [data, { "doc-cv": { filename: "Mohamed_CV.pdf", mimeType: "application/pdf", base64: pdf } }] as const) as { filled: number; total: number; problems: string[] };

    expect(result.problems).toEqual([]);
    expect(result.filled).toBe(8);
    const values = await page.evaluate(() => ({
      first: (document.getElementById("firstname") as HTMLInputElement).value,
      phone: (document.getElementById("phone") as HTMLInputElement).value,
      address: (document.getElementById("address") as HTMLInputElement).value,
      postcode: (document.getElementById("postcode") as HTMLInputElement).value,
      salary: (document.querySelector('[name="CA_36432"]') as HTMLInputElement).value,
      iqama: (document.querySelector('[name="CA_50968"]') as HTMLInputElement).value,
      resume: (document.querySelector('[name="resume_name"]') as HTMLInputElement).value,
    }));
    expect(values).toEqual({ first: "MOHAMED", phone: "50 000 0000", address: "Riyadh, Saudi Arabia", postcode: "", salary: "25000", iqama: "Yes", resume: "Mohamed_CV.pdf" });
    expect(submitted).toBe(false); // the user presses Submit, never the extension

    // The panel's "I submitted it" reports back for this application.
    await page.locator("#careerflow-panel").locator("button", { hasText: "I submitted it" }).click();
    const reports = await page.evaluate(() => (window as unknown as { __reports: unknown[] }).__reports);
    expect(reports).toEqual([{ applicationId: data.applicationId, how: "button" }]);
    await page.close();
  }, 120_000);
});
