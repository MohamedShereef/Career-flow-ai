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
    expect(autoapply.atsFromUrl("https://www.linkedin.com/jobs/view/1")).toBe("job_board");
    expect(autoapply.atsFromUrl("https://careers.example.com/jobs/1")).toBe("career_site");
  });
});
