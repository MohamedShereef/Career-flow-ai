/**
 * Real browser, real database, mock employer site: the full auto-apply path.
 * Skipped when no Chromium is available (set CHROME_PATH).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { applications, cvTailorings, fieldRecipes, jobs, pendingQuestions, submissionEvidence, submissionLedger } from "@careerflow/db";
import { ai, answers, autoapply, documents as documentsSvc, logins, profile, settings, sha256 } from "@careerflow/core";
import { renderCvPdf } from "../../../packages/core/src/cv-pdf";
import { getStorage } from "../../../packages/core/src/storage";
import { documents } from "@careerflow/db";
import { applyHandlers } from "../src/apply/handlers";
import { PORTAL_HTML, PORTAL_USER } from "./portal-mock";
import { TRICKY_HTML } from "./tricky-mock";
import { WORKABLE_HTML } from "./workable-mock";
import type { HandlerContext } from "../src/handlers";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

const chrome = process.env.CHROME_PATH;
const run = chrome && existsSync(chrome) ? describe : describe.skip;

let server: Server;
let base = "";
const received: Array<Record<string, string>> = [];
const portalSubmissions: Array<Record<string, string>> = [];
const trickySubmissions: Array<Record<string, string>> = [];
const workableSubmissions: Array<Record<string, string>> = [];
let implicitPosts = 0;

const FORM = (extra = "") => `<!doctype html><html><head><title>Senior Procurement Engineer – Acme Giga</title></head><body>
<h1>Senior Procurement Engineer</h1>
<form id="application" method="post" action="/submit" enctype="multipart/form-data">
  <label for="first_name">First Name *</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last Name *</label><input id="last_name" name="last_name" required>
  <label for="email">Email *</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
  <label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required accept=".pdf,.doc,.docx">
  <label for="linkedin">LinkedIn Profile</label><input id="linkedin" name="linkedin">
  <fieldset><legend>Are you legally authorized to work in Saudi Arabia? *</legend>
    <label><input type="radio" name="auth" value="yes" required> Yes</label>
    <label><input type="radio" name="auth" value="no"> No</label>
  </fieldset>
  <label for="why">Why are you interested in this role? *</label><textarea id="why" name="why" required></textarea>
  ${extra}
  <button type="submit">Submit Application</button>
</form></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/jobs/1" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><body><h1>Senior Procurement Engineer</h1><p>Great role.</p><a href="/jobs/1/apply">Apply now</a></body></html>`);
    }
    if (req.url === "/jobs/1/apply" || req.url === "/jobs/1/apply?sso=1") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(FORM());
    }
    if (req.url === "/handoff") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><body onload="document.forms[0].submit()"><form method="get" action="/jobs/1/apply"><input type="hidden" name="sso" value="1"></form>Redirecting…</body></html>`);
    }
    if (req.url === "/implicit") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><body><form method="post" action="/implicit/submit">
        <label for="fn">First Name</label><input id="fn" name="first_name">
        <label for="em">Email</label><input id="em" name="email" type="email">
        <label for="cv">Resume</label><input id="cv" name="resume" type="file">
        <input id="nat" name="nationality" role="combobox" aria-label="Nationality" aria-required="true" aria-owns="nat-list" aria-expanded="true" value="No Selection">
        <ul id="nat-list" role="listbox"></ul>
        <button type="submit">Submit Application</button></form>
        <script>
          const nat = document.getElementById("nat");
          nat.addEventListener("keydown", (e) => { if (e.key === "Enter") { window.__enterSeen = true; document.forms[0].submit(); } });
          nat.addEventListener("keyup", () => { document.getElementById("nat-list").innerHTML = '<li role="option">Other</li>'; });
          nat.addEventListener("blur", () => setTimeout(() => { nat.value = "No Selection"; }, 100)); // nothing chosen from a list
        </script>
        </body></html>`);
    }
    if (req.url === "/implicit/submit") {
      implicitPosts++;
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body>Thank you for applying</body></html>");
    }
    if (req.url === "/workable") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(WORKABLE_HTML);
    }
    if (req.url === "/workable/submit" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const fields: Record<string, string> = {};
        for (const m of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) fields[m[1]!] = m[2] ? `FILE:${m[2]}` : m[3]!;
        workableSubmissions.push(fields);
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Thank you for applying!</h1><p>Your application has been received.</p></body></html>");
      });
      return;
    }
    if (req.url === "/tricky") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(TRICKY_HTML);
    }
    if (req.url === "/tricky/submit" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const fields: Record<string, string> = {};
        for (const m of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) fields[m[1]!] = m[2] ? `FILE:${m[2]}` : m[3]!;
        trickySubmissions.push(fields);
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Thank you for applying!</h1><p>Your application has been received.</p></body></html>");
      });
      return;
    }
    if (req.url === "/portal" || req.url === "/portal/job/77") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(PORTAL_HTML);
    }
    if ((req.url === "/portal/login" || req.url === "/portal/submit") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const j = JSON.parse(body || "{}");
        if (req.url === "/portal/login") {
          res.writeHead(j.e === PORTAL_USER.email && j.p === PORTAL_USER.password ? 200 : 401).end();
        } else {
          portalSubmissions.push(j);
          res.writeHead(200).end("{}");
        }
      });
      return;
    }
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<form><label>Email<input type="email" name="u"></label><label>Password<input type="password" name="p"></label><button>Sign in</button></form>`);
    }
    if (req.url === "/submit" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const fields: Record<string, string> = {};
        for (const m of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) fields[m[1]!] = m[2] ? `FILE:${m[2]}:${m[3]!.length}` : m[3]!;
        received.push(fields);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><h1>Thank you for applying!</h1><p>Your application has been received.</p></body></html>`);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  ai.setAiTransportForTests(null);
  server?.close();
  await closeDb();
});

function ctxFor(kind: string, payload: Record<string, unknown>): HandlerContext {
  return {
    db: testDb(),
    task: { id: crypto.randomUUID(), kind, payload, checkpoint: null, timeoutSeconds: 600, attempts: 1 } as unknown as HandlerContext["task"],
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    log: () => undefined,
  };
}

async function setup(applyPath: string) {
  const { user } = await makeUser("apply");
  const db = testDb();
  await profile.updateProfile(db, user.id, { fullName: "Mohamed Shereef Farouk", contactEmail: "m@example.com", phone: "+966 50 000 0000", linkedinUrl: "https://linkedin.com/in/example", city: "Riyadh", yearsExperience: 9 });
  await profile.upsertExperience(db, user.id, { employer: "El Seif", title: "Senior Procurement Engineer", startDate: "2024-08", isCurrent: true, description: "Ran MEP tenders" });
  await settings.setConsent(db, user.id, "automation", true);
  const pdf = await renderCvPdf({ name: "Mohamed Shereef Farouk", headline: "Senior Procurement Engineer", contact: [], summary: "Procurement engineer with experience in construction tenders.", highlights: [], experiences: [], qualifications: [], skills: [] });
  const key = `users/${user.id}/cv_tailored/${crypto.randomUUID()}.pdf`;
  await getStorage().put(key, pdf, "application/pdf");
  const [doc] = await db.insert(documents).values({ userId: user.id, kind: "cv_tailored", storageKey: key, filename: "Mohamed_CV.pdf", mimeType: "application/pdf", sizeBytes: pdf.length, sha256: sha256(pdf) }).returning();
  const [job] = await db
    .insert(jobs)
    .values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Senior Procurement Engineer", companyName: "Acme Giga", employerKey: "acme giga", description: "Procurement role", sourceUrl: `${base}${applyPath}`, applyUrl: `${base}${applyPath}` })
    .returning();
  const [t] = await db
    .insert(cvTailorings)
    .values({ userId: user.id, jobId: job!.id, jobTitle: job!.title, companyName: job!.companyName, jobDescription: "Procurement role", profileVersion: 1, content: { coverLetter: null }, cvDocumentId: doc!.id, approvedAt: new Date() })
    .returning();
  return { user, job: job!, tailoring: t! };
}

run("auto-apply in a real browser", () => {
  it("reads the form, asks once, previews, and submits exactly once with evidence", async () => {
    const db = testDb();
    const { user, job } = await setup("/jobs/1");
    ai.setAiTransportForTests(async (req) => {
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1]!) as Array<{ key: string; question: string }>;
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: /why/i.test(q.question) ? "I run MEP tenders on large projects and want to do that on a giga-project." : null })) }) };
    });

    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r1 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { waiting?: number };
    expect(r1.waiting).toBe(1); // work authorisation is never guessed

    const [q] = await db.select().from(pendingQuestions).where(and(eq(pendingQuestions.userId, user.id), eq(pendingQuestions.status, "open")));
    expect(q!.questionText).toMatch(/authorized to work/i);
    expect(q!.options).toEqual(["Yes", "No"]);
    await answers.answerPendingQuestion(db, user.id, q!.id, { answer: "Yes", scope: "global" });
    expect(await autoapply.resumeWaiting(db, user.id)).toBe(1);

    const r2 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { previewId?: string; answers?: number };
    expect(r2.previewId).toBeTruthy();
    const detail = await autoapply.getDetail(db, user.id, app.id);
    expect(detail.app.status).toBe("awaiting_approval");
    const byLabel = Object.fromEntries(detail.preview!.data.answers.map((a) => [a.label, a]));
    expect(byLabel["First Name"]!.value).toEqual({ kind: "text", value: "Mohamed" });
    expect(byLabel["Last Name"]!.value).toEqual({ kind: "text", value: "Shereef Farouk" });
    expect(byLabel["Resume/CV"]!.source).toBe("document");
    expect(byLabel["Are you legally authorized to work in Saudi Arabia?"]!.source).toBe("saved_answer");
    expect(byLabel["Why are you interested in this role?"]!.source).toBe("ai");
    expect(received).toHaveLength(0); // nothing sent before approval

    const ap = await autoapply.approve(db, user.id, r2.previewId!);
    const r3 = (await applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))) as { outcome?: string };
    expect(r3.outcome).toBe("confirmed");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ first_name: "Mohamed", last_name: "Shereef Farouk", email: "m@example.com", auth: "yes" });
    expect(received[0]!.resume).toMatch(/^FILE:Mohamed_CV\.pdf:\d+/);

    const [a] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(a!.status).toBe("submitted_unverified");
    const [l] = await db.select().from(submissionLedger).where(eq(submissionLedger.applicationId, app.id));
    expect(l!.state).toBe("submitted");
    const ev = await db.select().from(submissionEvidence).where(eq(submissionEvidence.applicationId, app.id));
    expect(ev[0]!.summary).toMatch(/received/i);

    // Can't be applied to again, and the used approval can't be replayed.
    await expect(autoapply.startAutoApply(db, user.id, { jobId: job.id })).rejects.toMatchObject({ code: "already_applied" });
    await expect(applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))).rejects.toThrow();
    expect(received).toHaveLength(1);
  }, 120_000);

  it("stops at a sign-in page instead of trying to get past it", async () => {
    const db = testDb();
    const { user, job } = await setup("/login");
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { blocked?: string };
    expect(r.blocked).toBe("login_required");
    const [a] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(a!.status).toBe("needs_user_action");
    expect(a!.statusReason).toMatch(/needs an account/i);
    expect((a!.checkpointData as { loginHost?: string }).loginHost).toBe("127.0.0.1");
  }, 60_000);

  it("signs in to a Workday-style portal with the saved login, walks 3 steps, and submits once after approval", async () => {
    const db = testDb();
    const { user, job } = await setup("/portal/job/77");
    ai.setAiTransportForTests(async (req) => {
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1]!) as Array<{ key: string }>;
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: null })) }) };
    });
    await profile.updateProfile(db, user.id, { residencyCountry: "Saudi Arabia" });
    const host = "127.0.0.1";

    // 1) No saved login: stops and asks for one, naming the portal.
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r0 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { blocked?: string };
    expect(r0.blocked).toBe("login_required");
    let [a] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect((a!.checkpointData as { loginHost?: string }).loginHost).toBe(host);

    // 2) Wrong password: reports it, doesn't loop.
    await logins.saveLogin(db, user.id, { url: `http://${host}/portal`, username: PORTAL_USER.email, password: "wrong" });
    await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r1 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { blocked?: string };
    expect(r1.blocked).toBe("login_failed");
    expect((await logins.listLogins(db, user.id))[0]!.lastResult).toBe("failed");

    // 3) Correct login: signs in (switching from Create Account), fills step 1, asks the step-2 question once.
    await logins.saveLogin(db, user.id, { url: `http://${host}/portal`, username: PORTAL_USER.email, password: PORTAL_USER.password });
    await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r2 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { waiting?: number; step?: number };
    expect(r2).toMatchObject({ waiting: 1, step: 1 });
    const open = await answers.listPendingQuestions(db, user.id);
    const q = open.find((x) => /authorized to work in Saudi/i.test(x.questionText))!;
    expect(q.options).toEqual(["Yes", "No"]);
    await answers.answerPendingQuestion(db, user.id, q.id, { answer: "Yes", scope: "global" });
    await autoapply.resumeWaiting(db, user.id);

    const r3 = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { previewId?: string; steps?: number };
    expect(r3.steps).toBe(3);
    const d = await autoapply.getDetail(db, user.id, app.id);
    const labels = d.preview!.data.answers.map((x) => `${x.label}=${x.value.kind === "text" ? x.value.value : x.value.kind}`);
    expect(labels).toEqual(expect.arrayContaining(["Given Name(s)=Mohamed", "Family Name=Shereef Farouk", "Country=Saudi Arabia", "Resume/CV=file", "Are you legally authorized to work in Saudi Arabia?=Yes"]));
    expect(portalSubmissions).toHaveLength(0);
    expect((await logins.listLogins(db, user.id))[0]!.lastResult).toBe("ok");

    const ap = await autoapply.approve(db, user.id, r3.previewId!);
    const r4 = (await applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))) as { outcome?: string };
    expect(r4.outcome).toBe("confirmed");
    expect(portalSubmissions).toEqual([{ first: "Mohamed", last: "Shereef Farouk", country: "Saudi Arabia", phone: "+966 50 000 0000", auth: "Yes", resume: "Mohamed_CV.pdf" }]);
    [a] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(a!.status).toBe("submitted_unverified");
  }, 180_000);

  it("fills hidden-styled options, cascading fields and covered dropdowns; skips optional ones it can't set", async () => {
    const db = testDb();
    const { user, job } = await setup("/tricky");
    await answers.saveAnswer(db, user.id, { questionText: "Marital Status", answer: "Married", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Religion", answer: "Islam", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Highest Education Level", answer: "Bachelor's Degree", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Seniority Level", answer: "Senior", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Nationality", answer: "Egyptian", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Institution Country", answer: "Egypt", scope: "global" }); // education facts are asked once, never guessed
    let rescues = 0;
    ai.setAiTransportForTests(async (req) => {
      if (req.schemaName === "field_rescue") {
        rescues++;
        expect(req.user).toContain("Seniority Level");
        const step = (o: Record<string, unknown>) => ({ action: null, key: null, selector: null, chars: null, ms: null, ...o });
        return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ steps: [step({ action: "click_css", selector: "#lvl-toggle" }), step({ action: "click_option" })], reason: "The list opens from the toggle button next to the field." }) };
      }
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1]!) as Array<{ key: string; question: string }>;
      const ans = (q: string) => (/studying/i.test(q) ? "No" : /institution country/i.test(q) ? "Egypt" : /sport/i.test(q) ? "Football" : null);
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: ans(q.question) })) }) };
    });
    await profile.updateProfile(db, user.id, { residencyCountry: "Saudi Arabia", region: "Riyadh Region", dateOfBirth: "1990-03-15", idType: "Iqama" });
    const certPdf = await renderCvPdf({ name: "PMP Certificate", headline: "Project Management Professional", contact: [], summary: "Certificate of the Project Management Institute awarded to the candidate.", highlights: [], experiences: [], qualifications: [], skills: [] });
    await documentsSvc.uploadDocument(db, user.id, { name: "PMP-certificate.pdf", bytes: certPdf }, "certificate");
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { previewId?: string; blocked?: string; problems?: unknown };
    expect(r.blocked, JSON.stringify(r)).toBeUndefined();
    expect(r.previewId, JSON.stringify(r) + JSON.stringify((await answers.listPendingQuestions(db, user.id)).map((q) => q.questionText))).toBeTruthy();
    const d = await autoapply.getDetail(db, user.id, app.id);
    const got = Object.fromEntries(d.preview!.data.answers.map((x) => [x.label, x.value.kind === "text" ? x.value.value : x.value.kind]));
    expect(got).toMatchObject({ Country: "Saudi Arabia", "Marital Status": "Married", "Are you currently studying here?": "No", "Institution Country": "Egypt" });
    expect(got["Favourite sport"]).toBeUndefined(); // "Football" isn't an option → left empty, not blocking
    expect(got["Nationality"]).toBe("Egypt"); // the preview shows the site's own wording
    expect(got).toMatchObject({ "State / Province": "Riyadh Region", "Date of Birth": "15/03/1990", "National ID Card Type": "Iqama", Certificates: "file" });

    const ap = await autoapply.approve(db, user.id, r.previewId!);
    const s = (await applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))) as { outcome?: string };
    expect(s.outcome).toBe("confirmed");
    expect(trickySubmissions).toHaveLength(1);
    expect(trickySubmissions[0]).toMatchObject({ country: "SA", marital: "Married", studying: "N", inst_country: "Egypt", religion: "ISL", education: "Bachelor's Degree", seniority: "Senior", nationality: "Egypt", state: "Riyadh Region", dob: "15/03/1990", id_type: "Iqama", resume_name: "Mohamed_CV.pdf" });
    expect(trickySubmissions[0]!.certificates).toMatch(/^FILE:PMP-certificate\.pdf/);
    // Learned: the AI-found method was saved for this site and reused at submit without asking the AI again.
    expect(rescues).toBe(1);
    const learned = await db.select().from(fieldRecipes).where(like(fieldRecipes.strategy, "ai:%"));
    expect(learned).toHaveLength(1);
    expect(learned[0]!.successes).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(learned[0]!.steps)).not.toContain("Senior"); // methods never store anyone's answers
    const typed = await db.select().from(fieldRecipes).where(eq(fieldRecipes.strategy, "focus_type_enter"));
    expect(Math.max(...typed.map((t) => t.successes))).toBeGreaterThanOrEqual(2); // learned for the widget it worked on
  }, 300_000);

  it("Workable-style form: reads questions written beside the field, fits phone/salary to the field's format, picks the address suggestion", async () => {
    const db = testDb();
    const { user, job } = await setup("/workable");
    await profile.updateProfile(db, user.id, { address: "Riyadh, Saudi Arabia", postalCode: "13112" });
    await answers.saveAnswer(db, user.id, { questionText: "Expected Salary", answer: "SAR 25,000 monthly", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Are you willing to relocate within Saudi Arabia?", answer: "Yes", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Do you hold a valid Saudi Iqama?", answer: "Yes", scope: "global" });
    ai.setAiTransportForTests(async (req) => {
      if (req.schemaName === "field_rescue") return { model: "t", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ steps: [], reason: "none" }) };
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1] ?? "[]") as Array<{ key: string }>;
      return { model: "t", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: null })) }) };
    });
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { previewId?: string; blocked?: string; problems?: unknown };
    expect(r.blocked, JSON.stringify(r)).toBeUndefined();
    expect(r.previewId, JSON.stringify(r) + JSON.stringify((await answers.listPendingQuestions(db, user.id)).map((q) => q.questionText))).toBeTruthy();
    const d = await autoapply.getDetail(db, user.id, app.id);
    const got = Object.fromEntries(d.preview!.data.answers.map((x) => [x.label, x.value.kind === "text" ? x.value.value : x.value.kind]));
    // Questions read from the text beside the field, not "CA_36432".
    expect(got).toMatchObject({ "Expected Salary": "25000", "Are you willing to relocate within Saudi Arabia?": "Yes", Address: "Riyadh, Saudi Arabia", "Do you hold a valid Saudi Iqama?": "Yes" });
    expect(Object.keys(got).some((k) => /^CA_/.test(k))).toBe(false);

    const ap = await autoapply.approve(db, user.id, r.previewId!);
    const s = (await applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))) as { outcome?: string };
    expect(s.outcome).toBe("confirmed");
    expect(workableSubmissions).toHaveLength(1);
    expect(workableSubmissions[0]).toMatchObject({ phone: "50 000 0000", address: "Riyadh, Saudi Arabia", postal_code: "13112", CA_36432: "25000", CA_50967: "Yes", CA_50968: "Yes" });
  }, 240_000);

  it("never submits a form while preparing — not by Enter in a text field, not by the site's own script", async () => {
    const db = testDb();
    const { user, job } = await setup("/implicit");
    await answers.saveAnswer(db, user.id, { questionText: "Nationality", answer: "Egyptian", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "Institution Country", answer: "Egypt", scope: "global" }); // education facts are asked once, never guessed
    ai.setAiTransportForTests(async (req) => {
      if (req.schemaName === "field_rescue") {
        const step = (o: Record<string, unknown>) => ({ action: null, key: null, selector: null, chars: null, ms: null, ...o });
        return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ steps: [step({ action: "click_field" }), step({ action: "type_value" }), step({ action: "press", key: "Enter" })], reason: "type and confirm" }) };
      }
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: [] }) };
    });
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { blocked?: string };
    expect(r.blocked).toBe("fill_failed"); // the field can't be set — so it stops and tells you
    expect(implicitPosts).toBe(0); // and nothing was ever sent to the employer
  }, 120_000);

  it("still follows sign-in hand-offs that submit a hidden form by themselves on load", async () => {
    const db = testDb();
    const { user, job } = await setup("/handoff");
    ai.setAiTransportForTests(async (req) => {
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1] ?? "[]") as Array<{ key: string }>;
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: null })) }) };
    });
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { blocked?: string; waiting?: number };
    expect(r.blocked).toBeUndefined(); // reached the real form (it then asks the required questions)
    expect(r.waiting).toBeGreaterThan(0);
  }, 60_000);
});
