import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiDecisions, careerFacts } from "@careerflow/db";
import { setAiTransportForTests } from "../src/ai";
import { extractDocumentText } from "../src/cv-text";
import { renderCvPdf } from "../src/cv-pdf";
import { FactGuard, numbersIn } from "../src/fact-guard";
import * as cvImport from "../src/services/cv-import";
import * as documents from "../src/services/documents";
import * as profile from "../src/services/profile";
import * as tailor from "../src/services/tailor";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));

const JD = "We are hiring a Senior Procurement Engineer for MEP packages on a giga-project in Riyadh. You will run tenders, negotiate subcontracts, manage supplier performance and report to the Procurement Manager. Requirements: 8+ years procurement, PMP or CIPS, SAP experience.";

describe("fact guard", () => {
  it("normalizes figures", () => {
    expect(numbersIn("SAR 60M and 250 million, 15% and 1,200 items")).toEqual([60e6, 250e6, 15, 1200]);
  });
  it("drops sentences with numbers not in the profile and uncertified claims", () => {
    const g = new FactGuard(["Negotiated a SAR 60,000,000 package", "team of 3"], ["PMP"]);
    expect(g.keep("Negotiated packages worth SAR 60M")).toBe(true);
    expect(g.keep("Led a team of 3 engineers")).toBe(true);
    expect(g.keep("Managed a SAR 500M portfolio")).toBe(false);
    expect(g.keep("CIPS certified procurement lead")).toBe(false);
    expect(g.keep("PMP certified")).toBe(true);
    expect(g.paragraph("Strong negotiator. Saved 20% on steel. Known for delivery.")).toBe("Strong negotiator. Known for delivery.");
  });
});

describe("AI availability", () => {
  it("fails clearly and records 'unavailable' when no API key is set", async () => {
    const { user } = await makeUser();
    delete process.env.OPENAI_API_KEY;
    await profile.updateProfile(testDb(), user.id, { fullName: "Test User" });
    await profile.upsertExperience(testDb(), user.id, { employer: "A", title: "B", startDate: "2020-01" });
    await expect(tailor.tailorCv(testDb(), user.id, { jobTitle: "Buyer", companyName: "X", jobDescription: JD })).rejects.toMatchObject({ code: "ai_unavailable" });
    const rows = await testDb().select().from(aiDecisions).where(eq(aiDecisions.userId, user.id));
    expect(rows.map((r) => r.status)).toEqual(["unavailable"]);
  });
});

describe("CV import", () => {
  it("reads a PDF CV and applies only the items the user selects", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const pdf = await renderCvPdf({
      name: "Mohamed Example",
      headline: "Senior Materials & Procurement Engineer",
      contact: ["Riyadh", "+966 50 000 0000"],
      summary: "Procurement engineer with experience in construction tenders, supplier negotiation and materials management across large projects in Saudi Arabia.",
      highlights: ["Negotiated subcontracts above SAR 60M individually"],
      experiences: [{ title: "Senior Materials & Procurement Engineer", employer: "Example Contracting", location: "Riyadh", dates: "Oct 2017 - Present", bullets: ["Ran MEP tenders", "Managed a team of 3"] }],
      qualifications: ["PMP, PMI", "CIPS (in progress)"],
      skills: ["Negotiation", "SAP MM"],
    });
    const text = await extractDocumentText(pdf, "application/pdf");
    expect(text).toContain("Mohamed Example");
    const doc = await documents.uploadDocument(db, user.id, { name: "cv.pdf", bytes: pdf }, "cv_original");

    let sentPrompt = "";
    setAiTransportForTests(async (req) => {
      sentPrompt = req.user;
      return {
        model: "test-model",
        inputTokens: 1000,
        outputTokens: 500,
        content: JSON.stringify({
          fullName: "Mohamed Example", headline: "Senior Materials & Procurement Engineer", summary: "Procurement engineer...", email: null,
          phone: "+966 50 000 0000", linkedinUrl: "linkedin.com/in/example", city: "Riyadh", nationality: null, yearsExperience: null,
          experiences: [
            { employer: "Example Contracting", title: "Senior Materials & Procurement Engineer", location: "Riyadh", startDate: "2017-10", endDate: null, isCurrent: true, description: "Ran MEP tenders\nManaged a team of 3" },
            { employer: "No Dates Co", title: "Buyer", location: null, startDate: null, endDate: null, isCurrent: false, description: "x" },
          ],
          qualifications: [
            { kind: "certification", name: "PMP", issuer: "PMI", state: "held", obtainedOn: null },
            { kind: "certification", name: "CIPS", issuer: null, state: "in_progress", obtainedOn: null },
          ],
          skills: ["Negotiation", "SAP MM", "Tendering"],
          highlights: [{ category: "contract_value", statement: "Negotiated subcontracts above SAR 60M individually", numericValue: 60000000, unit: "SAR" }],
          warnings: [],
        }),
      };
    });

    const x = await cvImport.extractFromCv(db, user.id, doc.id);
    expect(sentPrompt).toContain("Example Contracting");
    const report = await cvImport.applyExtraction(db, user.id, x.id, {
      profileFields: ["fullName", "headline", "phone", "linkedinUrl", "city"],
      experiences: [0, 1],
      qualifications: [0, 1],
      skills: ["Negotiation", "SAP MM"],
      highlights: [0],
    });
    expect(report).toMatchObject({ experiences: 1, qualifications: 2, skills: 2, highlights: 1 });
    expect(report.skipped.join(" ")).toContain("no start date");

    const p = await profile.getProfile(db, user.id);
    expect(p.linkedinUrl).toBe("https://linkedin.com/in/example");
    const quals = await profile.listQualifications(db, user.id);
    expect(quals.find((q) => q.name === "CIPS")?.state).toBe("in_progress");
    // numbers from a CV are drafts until the user verifies their meaning
    expect(await profile.listCareerFacts(db, user.id, true)).toHaveLength(0);

    const [decision] = await db.select().from(aiDecisions).where(and(eq(aiDecisions.userId, user.id), eq(aiDecisions.stage, "cv_extraction")));
    expect(decision!.status).toBe("ok");
    expect(Number(decision!.costUsd ?? 0)).toBe(0); // unknown test model → no price claimed

    // re-applying does not duplicate the role
    const again = await cvImport.applyExtraction(db, user.id, x.id, { profileFields: [], experiences: [0], qualifications: [0], skills: [], highlights: [] });
    expect(again.experiences).toBe(0);
  });
});

describe("CV import tolerance", () => {
  it("saves good fields even when one is odd, and accepts year-only dates", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const doc = await documents.uploadDocument(db, user.id, { name: "cv.pdf", bytes: await renderCvPdf({ name: "A B", headline: "Buyer", contact: [], summary: "Procurement engineer with long experience in construction tenders, supplier negotiation and materials management across large projects in Saudi Arabia and the GCC region.", highlights: [], experiences: [{ title: "Procurement Engineer", employer: "El Seif", location: "Riyadh", dates: "Aug 2024 - Present", bullets: ["Ran MEP tenders and negotiated subcontracts"] }], qualifications: ["B.Sc. Engineering"], skills: ["Negotiation"] }) }, "cv_original");
    let prompt = "";
    setAiTransportForTests(async (req) => {
      prompt = req.system;
      return {
        model: "test-model", inputTokens: 1, outputTokens: 1,
        content: JSON.stringify({
          fullName: "Mohamed Shereef", headline: "Senior Procurement Engineer", summary: null, email: " M@Example.com ", phone: "+966 5 1234 5678",
          linkedinUrl: "LinkedIn: Mohamed Shereef", city: "Riyadh", nationality: null, yearsExperience: 9,
          experiences: [
            { employer: "El Seif", title: "Procurement Engineer", location: null, startDate: "2024-08-15", endDate: "Present", isCurrent: true, description: "x" },
            { employer: "Al Fahd", title: "Buyer", location: null, startDate: "2023", endDate: "2024", isCurrent: false, description: "y" },
          ],
          qualifications: [{ kind: "degree", name: "B.Sc. Engineering", issuer: null, state: "held", obtainedOn: "2017" }],
          skills: [], highlights: [], warnings: [],
        }),
      };
    });
    const x = await cvImport.extractFromCv(db, user.id, doc.id);
    expect(prompt).toContain("Today's date is");
    const r = await cvImport.applyExtraction(db, user.id, x.id, {
      profileFields: ["fullName", "headline", "contactEmail", "phone", "linkedinUrl", "city", "yearsExperience"],
      experiences: [0, 1], qualifications: [0], skills: [], highlights: [],
    });
    expect(r.profileFields).toBe(6);
    expect(r.experiences).toBe(2);
    expect(r.qualifications).toBe(1);
    expect(r.skipped.join(" ")).toContain("LinkedIn");
    const p = await profile.getProfile(db, user.id);
    expect(p.fullName).toBe("Mohamed Shereef");
    expect(p.contactEmail).toBe("m@example.com");
    const quals = await profile.listQualifications(db, user.id);
    expect(quals[0]!.obtainedOn).toBe("2017-01-01");
  });
});

describe("CV tailoring", () => {
  it("uses only verified facts and strips invented numbers and certifications", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await profile.updateProfile(db, user.id, { fullName: "Mohamed Example", city: "Riyadh", contactEmail: "m@example.com" });
    const exp = await profile.upsertExperience(db, user.id, { employer: "Example Contracting", title: "Senior Materials & Procurement Engineer", startDate: "2017-10", isCurrent: true, description: "Ran MEP tenders\nNegotiated subcontracts" });
    await profile.addQualification(db, user.id, { kind: "certification", name: "PMP", state: "held" });
    await profile.addQualification(db, user.id, { kind: "certification", name: "CIPS", state: "in_progress" });
    await profile.addSkills(db, user.id, ["Negotiation", "SAP MM", "Tendering"]);
    const verified = await profile.addCareerFact(db, user.id, { category: "contract_value", statement: "Negotiated subcontracts above SAR 60M individually", numericValue: 60000000, unit: "SAR" });
    await profile.verifyCareerFact(db, user.id, verified.id, "single contracts I negotiated");
    const draft = await profile.addCareerFact(db, user.id, { category: "savings", statement: "Saved SAR 9M on steel", numericValue: 9000000, unit: "SAR" });

    setAiTransportForTests(async () => ({
      model: "gpt-5-mini",
      inputTokens: 4000,
      outputTokens: 1500,
      content: JSON.stringify({
        headline: "Senior Procurement Engineer – MEP",
        summary: "Procurement engineer with 9 years in Saudi construction. CIPS certified buyer. Negotiated subcontracts above SAR 60M.",
        experiences: [
          { experienceId: exp.id, bullets: ["Ran MEP tenders end to end", "Managed a SAR 500M procurement portfolio", "Negotiated subcontracts above SAR 60M"] },
          { experienceId: "00000000-0000-0000-0000-000000000000", bullets: ["Invented role"] },
        ],
        highlightIds: [verified.id, draft.id, "not-an-id"],
        skills: ["SAP MM", "Negotiation", "Python"],
        matchedRequirements: ["MEP tenders", "PMP"],
        gaps: ["SAP certification"],
        changes: ["Led with MEP tendering"],
        coverLetter: "I am applying for the role. I bring 9 years of procurement. I cut costs by 30% every year.\n\nI hold the PMP.",
      }),
    }));

    const t = await tailor.tailorCv(db, user.id, { jobTitle: "Senior Procurement Engineer", companyName: "Acme Giga", jobDescription: JD });
    const got = await tailor.getTailoring(db, user.id, t.id);
    const c = got.content;
    expect(c.summary).not.toMatch(/CIPS certified/);
    expect(c.summary).toContain("9 years");
    expect(c.experiences).toHaveLength(1);
    expect(c.experiences[0]!.bullets).toEqual(["Ran MEP tenders end to end", "Negotiated subcontracts above SAR 60M"]);
    expect(c.highlightIds).toEqual([verified.id]);
    expect(c.skills).toEqual(["SAP MM", "Negotiation"]);
    expect(c.coverLetter).not.toContain("30%");
    expect(c.removedByGuard).toEqual(expect.arrayContaining(["Managed a SAR 500M procurement portfolio", "CIPS certified buyer."]));

    const { bytes } = await documents.getDocumentForDownload(db, user.id, got.cvDocumentId!);
    const text = await extractDocumentText(bytes, "application/pdf");
    expect(text).toContain("Mohamed Example");
    expect(text).toContain("CIPS (in progress)");
    expect(text).not.toContain("500M");
    expect(text).not.toContain("9M");
    expect(got.coverLetterDocumentId).toBeTruthy();

    // other users can't read it
    const other = await makeUser("other");
    await expect(tailor.getTailoring(db, other.user.id, t.id)).rejects.toMatchObject({ code: "not_found" });
    // draft fact still untouched
    const [d] = await db.select().from(careerFacts).where(eq(careerFacts.id, draft.id));
    expect(d!.status).toBe("draft");
  });
});
