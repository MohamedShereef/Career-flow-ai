import { afterAll, afterEach, describe, expect, it } from "vitest";
import { employerAssessments, jobs, tasks } from "@careerflow/db";
import { eq } from "drizzle-orm";
import { setAiTransportForTests } from "../src/ai";
import * as feedback from "../src/services/feedback";
import * as matching from "../src/services/matching";
import * as profile from "../src/services/profile";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));

const LONG = "Lead procurement of MEP packages including tendering, bid evaluation, negotiation and award for a giga-project in Riyadh. ".repeat(5);

describe("learning from decisions", () => {
  it("applies 'not interested' immediately, rules out the employer, and teaches the scorer", async () => {
    const db = testDb();
    const { user } = await makeUser();
    await profile.updateProfile(db, user.id, { fullName: "M", preferredTitles: ["Procurement Manager"], residencyCountry: "Saudi Arabia" });
    await profile.upsertExperience(db, user.id, { employer: "X", title: "Senior Procurement Engineer", startDate: "2017-10", isCurrent: true, description: "MEP tenders" });
    const mk = (company: string, title: string) => ({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title, companyName: company, employerKey: company.toLowerCase(), location: "Riyadh", sourceUrl: "https://x", applyUrl: "https://x", description: LONG, descriptionHash: crypto.randomUUID() });
    const [a, b, c] = await db.insert(jobs).values([mk("Brightline Contracting", "Procurement Manager"), mk("Brightline Contracting", "Senior Buyer"), mk("Gulf Giga Developer", "Procurement Lead")]).returning();
    for (const k of ["brightline contracting", "gulf giga developer"]) {
      await db.insert(employerAssessments).values({ employerKey: k, companyName: k, employerType: "client_developer", scale: "large", method: "ai" }).onConflictDoNothing();
    }
    const prompts: string[] = [];
    setAiTransportForTests(async (req) => {
      if (req.schemaName === "employer_vetting") return { model: "test", content: JSON.stringify({ employerType: "client_developer", scale: "large", pifAffiliated: "unknown", summary: "x", redFlags: [], confidence: 0.8 }) };
      prompts.push(req.user);
      return { model: "test", content: JSON.stringify({ score: 80, eligibility: "eligible", factors: [{ factor: "Fit", score: 80, explanation: "ok" }], summary: "Good fit.", rejectionReasons: [], roleFamily: "procurement" }) };
    });
    await matching.evaluateJobsForUser(db, user.id, { limit: 500 });
    const mine = new Set([a!.id, b!.id, c!.id]);
    expect((await matching.listMatches(db, user.id, "recommended")).filter((x) => mine.has(x.j.id))).toHaveLength(3);

    // The user rules out Brightline as an employer.
    await feedback.notInterested(db, user.id, a!.id, "employer", "Too many delayed payments");
    const now = await matching.getMatch(db, user.id, a!.id);
    expect(now!.e).toMatchObject({ decision: "rejected", method: "rule" });
    expect(now!.e!.rejectionReasons[0]).toMatch(/Your decision/);
    const [learnTask] = await db.select().from(tasks).where(eq(tasks.dedupeKey, `learn:${user.id}`));
    expect(learnTask!.payload).toMatchObject({ rescoreDecisions: ["recommended", "needs_review"] });

    // Re-scoring: the other Brightline job is ruled out without AI; the remaining job sees the lesson in its prompt.
    prompts.length = 0;
    const before = (await matching.getMatch(db, user.id, a!.id))!.e!.id;
    await matching.evaluateJobsForUser(db, user.id, { limit: 500, staleBefore: new Date(Date.now() + 1000), rescoreDecisions: ["recommended", "needs_review"] });
    expect((await matching.getMatch(db, user.id, a!.id))!.e!.id).toBe(before); // the job the user turned down is never re-scored
    expect((await matching.getMatch(db, user.id, b!.id))!.e).toMatchObject({ decision: "rejected", summary: "You said you're not interested in this employer." });
    const gulf = prompts.find((p) => p.includes("JOB: Procurement Lead at Gulf Giga Developer"))!;
    expect(gulf).toContain("LEARNED FROM THE CANDIDATE'S OWN DECISIONS");
    expect(gulf).toContain("Procurement Manager at Brightline Contracting");
    expect(gulf).toContain("Too many delayed payments");
    expect(prompts.some((p) => p.includes("JOB: Senior Buyer at Brightline"))).toBe(false); // ruled out without AI
    expect((await matching.getMatch(db, user.id, c!.id))!.e!.decision).toBe("recommended");

    // Undo brings the job back for normal scoring.
    await feedback.undoNotInterested(db, user.id, a!.id);
    expect(await matching.getMatch(db, user.id, a!.id)).toMatchObject({ e: null });
    expect((await feedback.summary(db, user.id)).notInterested).toBe(0);
  });
});
