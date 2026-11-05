/**
 * Real browser, real database, mock employer site: the full auto-apply path.
 * Skipped when no Chromium is available (set CHROME_PATH).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applications, cvTailorings, jobs, pendingQuestions, submissionEvidence, submissionLedger } from "@careerflow/db";
import { ai, answers, autoapply, logins, profile, settings, sha256 } from "@careerflow/core";
import { renderCvPdf } from "../../../packages/core/src/cv-pdf";
import { getStorage } from "../../../packages/core/src/storage";
import { documents } from "@careerflow/db";
import { applyHandlers } from "../src/apply/handlers";
import { PORTAL_HTML, PORTAL_USER } from "./portal-mock";
import { TRICKY_HTML } from "./tricky-mock";
import type { HandlerContext } from "../src/handlers";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

const chrome = process.env.CHROME_PATH;
const run = chrome && existsSync(chrome) ? describe : describe.skip;

let server: Server;
let base = "";
const received: Array<Record<string, string>> = [];
const portalSubmissions: Array<Record<string, string>> = [];
const trickySubmissions: Array<Record<string, string>> = [];

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
    if (req.url === "/jobs/1/apply") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(FORM());
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
    ai.setAiTransportForTests(async (req) => {
      const qs = JSON.parse(req.user.split("QUESTIONS:\n")[1]!) as Array<{ key: string; question: string }>;
      const ans = (q: string) => (/studying/i.test(q) ? "No" : /institution country/i.test(q) ? "Egypt" : /sport/i.test(q) ? "Football" : null);
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ answers: qs.map((q) => ({ key: q.key, answer: ans(q.question) })) }) };
    });
    await profile.updateProfile(db, user.id, { residencyCountry: "Saudi Arabia" });
    const app = await autoapply.startAutoApply(db, user.id, { jobId: job.id });
    const r = (await applyHandlers["application.prepare"]!(ctxFor("application.prepare", { applicationId: app.id }))) as { previewId?: string; blocked?: string; problems?: unknown };
    expect(r.blocked, JSON.stringify(r.problems)).toBeUndefined();
    const d = await autoapply.getDetail(db, user.id, app.id);
    const got = Object.fromEntries(d.preview!.data.answers.map((x) => [x.label, x.value.kind === "text" ? x.value.value : x.value.kind]));
    expect(got).toMatchObject({ Country: "Saudi Arabia", "Marital Status": "Married", "Are you currently studying here?": "No", "Institution Country": "Egypt" });
    expect(got["Favourite sport"]).toBeUndefined(); // "Football" isn't an option → left empty, not blocking

    const ap = await autoapply.approve(db, user.id, r.previewId!);
    const s = (await applyHandlers["application.submit"]!(ctxFor("application.submit", { applicationId: app.id, approvalId: ap.id }))) as { outcome?: string };
    expect(s.outcome).toBe("confirmed");
    expect(trickySubmissions).toHaveLength(1);
    expect(trickySubmissions[0]).toMatchObject({ country: "SA", marital: "Married", studying: "N", inst_country: "Egypt", religion: "ISL" });
  }, 120_000);
});
