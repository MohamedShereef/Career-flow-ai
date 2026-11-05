import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cvTailorings, submissionLedger } from "@careerflow/db";
import { renderCvPdf } from "../src/cv-pdf";
import * as applications from "../src/services/applications";
import * as documents from "../src/services/documents";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);

describe("assisted apply", () => {
  it("needs approval, records the submission once, and blocks a second application", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const pdf = await renderCvPdf({ name: "A B", headline: "Buyer", contact: [], summary: "Procurement engineer with experience in construction tenders and supplier negotiation.", highlights: [], experiences: [], qualifications: [], skills: [] });
    const doc = await documents.uploadDocument(db, user.id, { name: "cv.pdf", bytes: pdf }, "supporting");
    const [t] = await db
      .insert(cvTailorings)
      .values({ userId: user.id, jobTitle: "Purchasing Team Leader", companyName: "Acme Arabia", jobDescription: "Lead purchasing.", profileVersion: 1, content: {}, cvDocumentId: doc.id })
      .returning();

    await expect(applications.prepare(db, user.id, t!.id, "https://acme.example/jobs/1")).rejects.toMatchObject({ code: "not_approved" });
    await db.update(cvTailorings).set({ approvedAt: new Date() }).where(eq(cvTailorings.id, t!.id));
    await expect(applications.prepare(db, user.id, t!.id)).rejects.toMatchObject({ code: "need_url" });
    await expect(applications.prepare(db, user.id, t!.id, "not a link")).rejects.toMatchObject({ code: "invalid_url" });

    const p = await applications.prepare(db, user.id, t!.id, "https://acme.example/jobs/1");
    expect(p.applyUrl).toBe("https://acme.example/jobs/1");
    // second open reuses the same application
    expect((await applications.prepare(db, user.id, t!.id)).applicationId).toBe(p.applicationId);

    expect(await applications.markSubmitted(db, user.id, p.applicationId)).toEqual({ alreadyRecorded: false });
    expect(await applications.markSubmitted(db, user.id, p.applicationId)).toEqual({ alreadyRecorded: true });
    const ledger = await db.select().from(submissionLedger).where(eq(submissionLedger.userId, user.id));
    expect(ledger).toHaveLength(1);

    const view = await applications.getForTailoring(db, user.id, t!.id);
    expect(view.application?.status).toBe("submitted_unverified");
    await expect(applications.prepare(db, user.id, t!.id)).rejects.toMatchObject({ code: "already_applied" });

    // another user can't touch it
    const { user: other } = await makeUser();
    await expect(applications.markSubmitted(db, other.id, p.applicationId)).rejects.toMatchObject({ status: 404 });
  });
});
