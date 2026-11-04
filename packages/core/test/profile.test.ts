import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applicantProfiles } from "@careerflow/db";
import * as profile from "../src/services/profile";
import * as settings from "../src/services/settings";
import * as documents from "../src/services/documents";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);

describe("applicant profile", () => {
  it("encrypts phone and salary at rest and bumps profile version", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const before = await profile.getProfile(db, user.id);
    const p = await profile.updateProfile(db, user.id, {
      phone: "+966 50 000 0000",
      expectedSalary: "35000",
      salaryCurrency: "SAR",
      preferredTitles: ["Senior Procurement Engineer", "Procurement Manager", "Procurement Manager"],
    });
    expect(p.phone).toBe("+966 50 000 0000");
    expect(p.preferredTitles).toEqual(["Senior Procurement Engineer", "Procurement Manager"]);
    expect(p.profileVersion).toBe(before.profileVersion + 1);
    const [raw] = await db.select().from(applicantProfiles).where(eq(applicantProfiles.userId, user.id));
    expect(raw!.phoneEnc).not.toContain("966");
    expect(raw!.expectedSalaryEnc).not.toContain("35000");
  });

  it("rejects inconsistent dates", async () => {
    const { user } = await makeUser();
    await expect(
      profile.upsertExperience(testDb(), user.id, { employer: "X", title: "Y", startDate: "2020-05", endDate: "2019-01" }),
    ).rejects.toMatchObject({ code: "invalid_experience" });
  });

  it("numeric facts need a confirmed meaning before they become verified", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const fact = await profile.addCareerFact(db, user.id, {
      category: "contract_value",
      statement: "Negotiated a single subcontract package worth SAR 60M",
      numericValue: 60000000,
      unit: "SAR",
    });
    expect(fact.status).toBe("draft");
    expect((await profile.listCareerFacts(db, user.id, true))).toHaveLength(0);
    await expect(profile.verifyCareerFact(db, user.id, fact.id)).rejects.toMatchObject({ code: "meaning_required" });
    const v = await profile.verifyCareerFact(db, user.id, fact.id, "Value of one contract I negotiated individually");
    expect(v.status).toBe("verified");
    expect(await profile.listCareerFacts(db, user.id, true)).toHaveLength(1);
  });

  it("does not let one user edit another's experience", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const exp = await profile.upsertExperience(testDb(), a.user.id, { employer: "A Co", title: "Engineer", startDate: "2017-10-01", isCurrent: true });
    await expect(profile.upsertExperience(testDb(), b.user.id, { employer: "Hacked", title: "x", startDate: "2017-10-01" }, exp.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(profile.deleteExperience(testDb(), b.user.id, exp.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces pilot limits and atomic daily quotas", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await expect(settings.updateSettings(db, user.id, { maxSubmissionsPerDay: 50 })).rejects.toMatchObject({ code: "invalid_settings" });
    const results = await Promise.all(Array.from({ length: 12 }, () => settings.consumeDailyQuota(db, user.id, "submissions", 5, "2026-11-04")));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("stores CVs privately, verifies type by content, and checks integrity on download", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const db = testDb();
    const pdf = Buffer.from("%PDF-1.4\n% test cv\n");
    const doc = await documents.uploadDocument(db, a.user.id, { name: "My CV (final).pdf", bytes: pdf }, "cv_original");
    expect(doc.isPrimary).toBe(true);
    await expect(documents.uploadDocument(db, a.user.id, { name: "evil.pdf", bytes: Buffer.from("<script>") }, "cv_original")).rejects.toMatchObject({ code: "bad_type" });
    const dl = await documents.getDocumentForDownload(db, a.user.id, doc.id);
    expect(dl.bytes.equals(pdf)).toBe(true);
    await expect(documents.getDocumentForDownload(db, b.user.id, doc.id)).rejects.toMatchObject({ code: "not_found" });
    const second = await documents.uploadDocument(db, a.user.id, { name: "cv2.pdf", bytes: Buffer.from("%PDF-1.4 two") }, "cv_original");
    expect(second.isPrimary).toBe(false);
    await documents.setPrimaryCv(db, a.user.id, second.id);
    const list = await documents.listDocuments(db, a.user.id);
    expect(list.filter((d) => d.isPrimary).map((d) => d.id)).toEqual([second.id]);
  });
});
