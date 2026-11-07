import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, jobs, submissionLedger } from "@careerflow/db";
import { renderCvPdf } from "../src/cv-pdf";
import * as autoapply from "../src/services/autoapply";
import * as documents from "../src/services/documents";
import * as extension from "../src/services/extension";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);

describe("Chrome extension hand-off", () => {
  it("links with a code, finds the application from the employer's page, serves the reviewed answers and records the submission", async () => {
    const { user } = await makeUser("ext");
    const other = await makeUser("ext-other");
    const db = testDb();

    const { token } = await extension.createToken(db, user.id);
    expect(token).toMatch(/^cfx_/);
    expect(await extension.authenticate(db, token)).toBe(user.id);
    expect(await extension.authenticate(db, "cfx_wrong")).toBeNull();
    expect(await extension.authenticate(db, null)).toBeNull();

    const pdf = await renderCvPdf({ name: "Mohamed", headline: "Procurement", contact: [], summary: "Procurement engineer.", highlights: [], experiences: [], qualifications: [], skills: [] });
    const cv = await documents.uploadDocument(db, user.id, { name: "Tailored_CV.pdf", bytes: pdf }, "cv_tailored" as never);
    const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Procurement Governance & Reporting", companyName: "Qiddiya Investment Company", employerKey: "qiddiya investment company", sourceUrl: "https://apply.workable.com/j/CC974086D8", applyUrl: "https://apply.workable.com/j/CC974086D8/apply" }).returning();
    const [app] = await db.insert(applications).values({ userId: user.id, jobId: job!.id, employerKey: "qiddiya investment company", status: "needs_user_action", checkpoint: "finish_in_browser", tailoredCvDocumentId: cv.id }).returning();
    await autoapply.savePreview(db, {
      applicationId: app!.id, url: job!.applyUrl, atsKind: "workable", skippedOptional: 0, screenshot: Buffer.from("png"),
      answers: [
        { key: "text:firstname", label: "First name", type: "text", value: { kind: "text", value: "MOHAMED" }, source: "profile", needsReview: false },
        { key: "radio:ca_35795", label: "Highest Education Level", type: "radio", value: { kind: "text", value: "Bachelor Degree" }, source: "saved_answer", needsReview: false },
        { key: "file:resume", label: "Resume", type: "file", value: { kind: "file", doc: "cv" }, source: "document", needsReview: false },
      ],
    });
    await db.update(applications).set({ status: "needs_user_action", checkpoint: "finish_in_browser" }).where(eq(applications.id, app!.id));

    // The employer's page link differs from the stored one (account slug added): the job code matches.
    const h = await extension.handoff(db, user.id, "https://apply.workable.com/qiddiya-investment-company-1/j/CC974086D8/apply");
    expect(h).toMatchObject({ applicationId: app!.id, company: "Qiddiya Investment Company" });
    expect(h!.answers.find((a) => a.label === "First name")!.value).toBe("MOHAMED");
    expect(h!.answers.find((a) => a.label === "Resume")!.file).toEqual([{ documentId: cv.id, filename: "Tailored_CV.pdf" }]);
    // Another job page, or someone else's account, gets nothing.
    expect(await extension.handoff(db, user.id, "https://apply.workable.com/qiddiya-investment-company-1/j/ZZ00000000/apply")).toBeNull();
    expect(await extension.handoff(db, other.user.id, "https://apply.workable.com/qiddiya-investment-company-1/j/CC974086D8/apply")).toBeNull();
    await expect(extension.fileFor(db, other.user.id, cv.id)).rejects.toMatchObject({ status: 404 });
    expect((await extension.fileFor(db, user.id, cv.id)).bytes.length).toBeGreaterThan(100);

    // Sent from Chrome: recorded once, in the never-twice ledger.
    await extension.markSent(db, user.id, app!.id, { url: "https://apply.workable.com/x", confirmation: "Thank you for applying" });
    const [a] = await db.select().from(applications).where(eq(applications.id, app!.id));
    expect(a!.status).toBe("submitted_unverified");
    const [l] = await db.select().from(submissionLedger).where(eq(submissionLedger.jobDedupeKey, job!.dedupeKey));
    expect(l!.state).toBe("submitted");
    expect(await extension.handoff(db, user.id, "https://apply.workable.com/qiddiya-investment-company-1/j/CC974086D8/apply")).toBeNull(); // nothing left to fill

    const [t] = await extension.listTokens(db, user.id);
    await extension.revokeToken(db, user.id, t!.id);
    expect(await extension.authenticate(db, token)).toBeNull();
  });
});
