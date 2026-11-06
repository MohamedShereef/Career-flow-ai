import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setAiTransportForTests } from "../src/ai";
import * as answers from "../src/services/answers";
import * as autoapply from "../src/services/autoapply";
import * as profile from "../src/services/profile";
import * as settings from "../src/services/settings";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));

const ctx = (userId: string) => ({
  userId,
  userEmail: "login@example.com",
  applicationId: crypto.randomUUID(),
  job: { id: crypto.randomUUID(), title: "Procurement Manager", companyName: "Acme Giga", description: "Lead procurement." },
  hasCoverLetter: false,
  coverLetterText: null,
});

describe("answer planning", () => {
  it("fills from the profile, never guesses sensitive questions, and rejects invented numbers", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await profile.updateProfile(db, user.id, { fullName: "Mohamed Shereef", city: "Riyadh", residencyCountry: "Saudi Arabia", yearsExperience: 9 });
    await profile.upsertExperience(db, user.id, { employer: "El Seif", title: "Senior Procurement Engineer", startDate: "2024-08", isCurrent: true, description: "Ran MEP tenders" });
    setAiTransportForTests(async () => ({
      model: "test-model", inputTokens: 1, outputTokens: 1,
      content: JSON.stringify({ answers: [
        { key: "t:biggest", answer: "I negotiated a SAR 900M package." }, // not in profile → rejected
        { key: "t:tools", answer: "SAP and Oracle" },
      ] }),
    }));
    const snap: autoapply.FormSnapshot = {
      url: "https://x", atsKind: "greenhouse", pageTitle: "", blockers: [],
      fields: [
        { key: "t:first", label: "First Name", type: "text", required: true },
        { key: "t:email", label: "Email", type: "email", required: true },
        { key: "s:country", label: "Country", type: "select", required: true, options: ["Egypt", "Saudi Arabia", "UAE"] },
        { key: "t:company", label: "Current company", type: "text", required: false },
        { key: "t:salary", label: "Expected salary (SAR)", type: "text", required: true },
        { key: "r:gender", label: "Gender", type: "radio", required: false, options: ["Male", "Female"] },
        { key: "c:privacy", label: "I agree to the privacy notice", type: "checkbox", required: true },
        { key: "t:biggest", label: "Describe your biggest negotiation", type: "textarea", required: true },
        { key: "t:tools", label: "Which ERP systems have you used?", type: "text", required: false },
        { key: "f:cv", label: "Resume", type: "file", required: true },
      ],
    };
    const plan = await autoapply.planAnswers(db, ctx(user.id), snap);
    const got = Object.fromEntries(plan.answers.map((a) => [a.key, a]));
    expect(got["t:first"]!.value).toEqual({ kind: "text", value: "Mohamed" });
    expect(got["t:email"]!.value).toMatchObject({ kind: "text", value: expect.stringMatching(/@example\.com$/) });
    expect(got["s:country"]!.value).toEqual({ kind: "text", value: "Saudi Arabia" });
    expect(got["t:company"]!.value).toEqual({ kind: "text", value: "El Seif" });
    expect(got["f:cv"]!.value).toEqual({ kind: "file", doc: "cv" });
    expect(got["t:tools"]).toMatchObject({ source: "ai", needsReview: true });
    expect(got["r:gender"]).toBeUndefined(); // protected question: never answered for you
    expect(plan.missing.map((m) => m.key).sort()).toEqual(["c:privacy", "t:biggest", "t:salary"]);

    // Once the user saves answers, they are reused (and choices are matched to options).
    await answers.saveAnswer(db, user.id, { questionText: "I agree to the privacy notice", answer: "Yes", scope: "global" });
    const again = await autoapply.planAnswers(db, ctx(user.id), snap);
    expect(again.answers.find((a) => a.key === "c:privacy")).toMatchObject({ source: "saved_answer", value: { kind: "bool", value: true } });
  });

  it("hashes answers deterministically regardless of order", () => {
    const a: autoapply.PlannedAnswer[] = [
      { key: "a", label: "A", type: "text", value: { kind: "text", value: "1" }, source: "profile", needsReview: false },
      { key: "b", label: "B", type: "file", value: { kind: "file", doc: "cv" }, source: "document", needsReview: false },
    ];
    const base = { applicationId: "x", jobId: "y", cvSha: "c", coverSha: null };
    expect(autoapply.contentHash({ ...base, answers: a })).toBe(autoapply.contentHash({ ...base, answers: [...a].reverse() }));
    expect(autoapply.contentHash({ ...base, answers: a })).not.toBe(autoapply.contentHash({ ...base, answers: [{ ...a[0]!, value: { kind: "text", value: "2" } }, a[1]!] }));
    expect(autoapply.contentHash({ ...base, answers: a })).not.toBe(autoapply.contentHash({ ...base, cvSha: "other", answers: a }));
  });
});

describe("autopilot switches", () => {
  it("needs consent, and submitting without asking stays locked until 5 approved applications were sent", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await expect(autoapply.setAutopilot(db, user.id, { prepare: true })).rejects.toMatchObject({ code: "no_consent" });
    await settings.setConsent(db, user.id, "automation", true);
    await autoapply.setAutopilot(db, user.id, { prepare: true });
    expect((await settings.getSettings(db, user.id)).autopilotEnabled).toBe(true);
    await expect(autoapply.setAutopilot(db, user.id, { autoSubmit: true })).rejects.toMatchObject({ code: "locked" });
    const st = await autoapply.autopilotStatus(db, user.id);
    expect(st).toMatchObject({ approvedSubmitted: 0, needed: 5, unlocked: false, prepareEnabled: true, autoSubmit: false });
  });

  it("recognises application systems from the link", () => {
    expect(autoapply.atsFromUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(autoapply.atsFromUrl("https://jobs.lever.co/acme/1")).toBe("lever");
    expect(autoapply.atsFromUrl("https://kbr.wd5.myworkdayjobs.com/KBR_Careers/job/1")).toBe("workday");
    expect(autoapply.atsFromUrl("https://neom.jobs2web.com/job/1")).toBe("successfactors");
    expect(autoapply.atsFromUrl("https://www.linkedin.com/jobs/view/1")).toBe("linkedin");
    expect(autoapply.atsFromUrl("https://www.recruit.net/job/x")).toBe("job_board");
    expect(autoapply.atsFromUrl("https://careers.example.com/jobs/1")).toBe("career_site");
  });
});

describe("employer link finder", () => {
  it("prefers the employer's own posting over job boards, from listing links or one cached search", async () => {
    const { employerLink } = await import("../src/index");
    const { jobs } = await import("@careerflow/db");
    const db = testDb();
    const [job] = await db
      .insert(jobs)
      .values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Purchasing Team Leader", companyName: "Johnson Controls Arabia", employerKey: "johnson controls arabia", sourceUrl: "https://www.recruit.net/job/x", applyUrl: "https://www.recruit.net/job/x", raw: { applyOptions: ["https://www.recruit.net/job/x", "https://www.linkedin.com/jobs/view/1"] } })
      .returning();
    expect(autoapply.isJobBoardUrl(job!.applyUrl)).toBe(true);
    let searches = 0;
    const search = async () => {
      searches++;
      return [
        { link: "https://jooble.org/jdp/123", title: "Purchasing Team Leader - Riyadh" },
        { link: "https://jci.wd5.myworkdayjobs.com/JCI/job/Riyadh/Purchasing-Team-Leader_WD123", title: "Purchasing Team Leader - Johnson Controls" },
      ];
    };
    const r = await employerLink.findEmployerLink(db, job!, { search });
    expect(r).toEqual({ url: "https://jci.wd5.myworkdayjobs.com/JCI/job/Riyadh/Purchasing-Team-Leader_WD123", via: "search" });
    const [again] = await db.select().from(jobs).where((await import("drizzle-orm")).eq(jobs.id, job!.id));
    expect(await employerLink.findEmployerLink(db, again!, { search })).toMatchObject({ via: "search" });
    expect(searches).toBe(1); // cached

    expect(employerLink.looksLikeEmployerPosting("https://careers.otherco.com/job/1", "Purchasing Team Leader", "Johnson Controls Arabia")).toBe(false);
    expect(employerLink.looksLikeEmployerPosting("https://boards.greenhouse.io/johnsoncontrols/jobs/1", "Purchasing Team Leader", "Johnson Controls Arabia", "Purchasing Team Leader at Johnson Controls")).toBe(true);
  });
});

describe("interrupted submit", () => {
  it("turns a submit cut off after the point of no return into an 'unclear' application, never a retry", async () => {
    const { applications, jobs, submissionLedger, tasks } = await import("@careerflow/db");
    const { eq } = await import("drizzle-orm");
    const { user } = await makeUser();
    const db = testDb();
    const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Buyer", companyName: "Acme", employerKey: "acme", sourceUrl: "https://x", applyUrl: "https://x" }).returning();
    const [app] = await db.insert(applications).values({ userId: user.id, jobId: job!.id, employerKey: "acme", status: "processing" }).returning();
    await db.insert(submissionLedger).values({ userId: user.id, jobDedupeKey: job!.dedupeKey, employerKey: "acme", applicationId: app!.id, state: "attempting" });
    await db.insert(tasks).values({ kind: "application.submit", payload: { applicationId: app!.id, approvalId: crypto.randomUUID() }, status: "blocked", checkpoint: { irreversible: true } });

    expect(await autoapply.reconcileInterruptedSubmits(db)).toBe(1);
    const [a] = await db.select().from(applications).where(eq(applications.id, app!.id));
    expect(a).toMatchObject({ status: "needs_user_action", checkpoint: "uncertain" });
    const [l] = await db.select().from(submissionLedger).where(eq(submissionLedger.applicationId, app!.id));
    expect(l!.state).toBe("uncertain");
    await settings.setConsent(db, user.id, "automation", true);
    await expect(autoapply.startAutoApply(db, user.id, { jobId: job!.id })).rejects.toMatchObject({ code: "already_applied" });
    expect(await autoapply.reconcileInterruptedSubmits(db)).toBe(0);
  });
});

describe("answers the employer's form rejected", () => {
  it("asks again with the site's message and format, then uses the new answer", async () => {
    const { pendingQuestions } = await import("@careerflow/db");
    const { and, eq } = await import("drizzle-orm");
    const { user } = await makeUser();
    const db = testDb();
    await answers.saveAnswer(db, user.id, { questionText: "G.P.A", answer: "Very Good", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "National ID Card Type", answer: "Passport", scope: "global" });
    const snap: autoapply.FormSnapshot = {
      url: "https://x", atsKind: "successfactors", pageTitle: "", blockers: [],
      fields: [
        { key: "t:gpa", label: "G.P.A", type: "text", required: true },
        { key: "c:idtype", label: "National ID Card Type", type: "combobox", required: true, options: ["Iqama", "National ID", "Passport"] },
      ],
    };
    const base = ctx(user.id);
    // "Very Good" isn't a number, so the GPA is asked even before any rejection.
    let plan = await autoapply.planAnswers(db, base, snap);
    expect(plan.missing.map((f) => f.key)).toEqual(["t:gpa"]);

    // The site rejected the ID type last time: ask again (with its message) even though an answer is saved.
    const rejectedCtx = { ...base, rejected: { "national id card type": { message: "Invalid value", at: new Date().toISOString() } } };
    plan = await autoapply.planAnswers(db, rejectedCtx, snap);
    expect(plan.missing.map((f) => f.key).sort()).toEqual(["c:idtype", "t:gpa"]);
    await autoapply.askMissing(db, rejectedCtx, plan.missing);
    const open = await db.select().from(pendingQuestions).where(and(eq(pendingQuestions.userId, user.id), eq(pendingQuestions.status, "open")));
    const idq = open.find((q) => q.questionText === "National ID Card Type")!;
    expect(idq.context).toContain("The site rejected the previous answer: “Invalid value”");
    expect(idq.options).toEqual(["Iqama", "National ID", "Passport"]);
    expect(open.find((q) => q.questionText === "G.P.A")!.context).toContain("expects a number");

    // A new answer given after the rejection is used.
    await new Promise((r) => setTimeout(r, 10));
    await answers.answerPendingQuestion(db, user.id, idq.id, { answer: "Iqama", scope: "global" });
    await answers.saveAnswer(db, user.id, { questionText: "G.P.A", answer: "3.2", scope: "global" });
    plan = await autoapply.planAnswers(db, rejectedCtx, snap);
    expect(plan.missing).toHaveLength(0);
    expect(Object.fromEntries(plan.answers.map((a) => [a.key, a.value]))).toEqual({ "t:gpa": { kind: "text", value: "3.2" }, "c:idtype": { kind: "text", value: "Iqama" } });
  });
});

describe("cancel and delete", () => {
  it("stops queued and running preparation, deletes only unsent applications, and keeps the never-twice ledger", async () => {
    const { applications, jobs, submissionLedger, tasks } = await import("@careerflow/db");
    const { eq, sql } = await import("drizzle-orm");
    const { user } = await makeUser();
    const db = testDb();
    const mkJob = async () => (await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Buyer", companyName: "Acme", employerKey: "acme", sourceUrl: "https://x", applyUrl: "https://x" }).returning())[0]!;

    // An application being prepared: Cancel stops its tasks (even the running one) and records nothing more.
    const j1 = await mkJob();
    const [a1] = await db.insert(applications).values({ userId: user.id, jobId: j1.id, employerKey: "acme", status: "processing" }).returning();
    await db.insert(tasks).values([
      { kind: "application.prepare", payload: { applicationId: a1!.id }, status: "running", lockedBy: "w1" },
      { kind: "application.prepare", payload: { applicationId: a1!.id }, status: "queued" },
    ]);
    await autoapply.cancel(db, user.id, a1!.id);
    const left = (await db.execute(sql`SELECT status FROM tasks WHERE payload->>'applicationId' = ${a1!.id}`)).rows as Array<{ status: string }>;
    expect(left.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
    expect(await autoapply.isStopped(db, a1!.id)).toBe(true);
    await autoapply.recordWaitingForAnswers(db, a1!.id, 2); // a late write from the stopped task is ignored
    expect((await db.select().from(applications).where(eq(applications.id, a1!.id)))[0]!.status).toBe("withdrawn");

    // Delete removes it, so the job can be started fresh.
    await autoapply.deleteApplication(db, user.id, a1!.id);
    expect(await db.select().from(applications).where(eq(applications.id, a1!.id))).toHaveLength(0);
    expect(await autoapply.isStopped(db, a1!.id)).toBe(true);

    // Something sent (or maybe sent) can't be deleted; another user can't delete yours.
    const j2 = await mkJob();
    const [a2] = await db.insert(applications).values({ userId: user.id, jobId: j2.id, employerKey: "acme", status: "submitted_unverified" }).returning();
    await expect(autoapply.deleteApplication(db, user.id, a2!.id)).rejects.toMatchObject({ code: "cannot_delete" });
    const j3 = await mkJob();
    const [a3] = await db.insert(applications).values({ userId: user.id, jobId: j3.id, employerKey: "acme", status: "needs_user_action" }).returning();
    await db.insert(submissionLedger).values({ userId: user.id, jobDedupeKey: j3.dedupeKey, employerKey: "acme", applicationId: a3!.id, state: "submitted" });
    await expect(autoapply.deleteApplication(db, user.id, a3!.id)).rejects.toMatchObject({ code: "cannot_delete" });
    const other = await makeUser("other");
    const j4 = await mkJob();
    const [a4] = await db.insert(applications).values({ userId: user.id, jobId: j4.id, employerKey: "acme", status: "needs_user_action" }).returning();
    await expect(autoapply.deleteApplication(db, other.user.id, a4!.id)).rejects.toMatchObject({ code: "not_found" });

    // A form rejected before: its ledger row survives deletion (link cleared), state stays "abandoned".
    const j5 = await mkJob();
    const [a5] = await db.insert(applications).values({ userId: user.id, jobId: j5.id, employerKey: "acme", status: "needs_user_action" }).returning();
    await db.insert(submissionLedger).values({ userId: user.id, jobDedupeKey: j5.dedupeKey, employerKey: "acme", applicationId: a5!.id, state: "abandoned" });
    await autoapply.deleteApplication(db, user.id, a5!.id);
    const [l5] = await db.select().from(submissionLedger).where(eq(submissionLedger.jobDedupeKey, j5.dedupeKey));
    expect(l5).toMatchObject({ applicationId: null, state: "abandoned" });
  });
});

describe("form rejections never loop", () => {
  it("prepares again only when the site flags something new, and at most 3 times in a row", async () => {
    const { applications, jobs } = await import("@careerflow/db");
    const { eq } = await import("drizzle-orm");
    const { user } = await makeUser();
    const db = testDb();
    const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Buyer", companyName: "Acme", employerKey: "acme", sourceUrl: "https://x", applyUrl: "https://x" }).returning();
    const [app] = await db.insert(applications).values({ userId: user.id, jobId: job!.id, employerKey: "acme", status: "processing" }).returning();
    const reject = (...labels: string[]) =>
      autoapply.recordOutcome(db, { applicationId: app!.id, approvalId: crypto.randomUUID(), outcome: "not_submitted", url: "https://x", summary: "", errors: labels.map((l) => `${l} is required`), invalid: labels.map((l) => ({ key: null, label: l, message: "required" })) });
    const state = async () => (await db.select().from(applications).where(eq(applications.id, app!.id)))[0]!;

    await reject("Institute");
    expect((await state()).status).toBe("processing"); // new field → asked and prepared again
    await reject("Institute");
    const s = await state();
    expect(s.status).toBe("needs_user_action"); // same field refused again → stop and tell the user
    expect(s.statusReason).toMatch(/keeps refusing the same fields/);
    await reject("G.P.A");
    await reject("State");
    await reject("ID Type");
    expect((await state()).status).toBe("needs_user_action"); // 3 automatic tries used → waits for Retry
  });
});

describe("technical details for support", () => {
  it("turns the stored field debug into copyable text on the application", async () => {
    const { applications, jobs } = await import("@careerflow/db");
    const { user } = await makeUser();
    const db = testDb();
    const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Buyer", companyName: "Acme", employerKey: "acme", sourceUrl: "https://x", applyUrl: "https://apply.example.com/j/1" }).returning();
    const [app] = await db.insert(applications).values({ userId: user.id, jobId: job!.id, employerKey: "acme", status: "processing" }).returning();
    await autoapply.recordBlocker(db, app!.id, { kind: "fill_failed", detail: "Address: the page didn't keep the value", debug: [{ label: "Address", wanted: "Riyadh, Saudi Arabia", debug: { tag: "input", role: "combobox", value: "R", attempts: [{ method: "fill" }], html: "<div><input id='address'></div>" } }] } as autoapply.Blocker);
    const d = await autoapply.getDetail(db, user.id, app!.id);
    expect(d.technical).toContain("── Address ──");
    expect(d.technical).toContain("role=combobox");
    expect(d.technical).toContain("<input id='address'>");
    expect(d.technical).toContain("https://apply.example.com/j/1");
  });
});
