import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { employerAssessments, jobEvaluations, jobSources, jobs } from "@careerflow/db";
import { setAiTransportForTests } from "../src/ai";
import { htmlToText } from "../src/discovery/text";
import { parseWorkdayUrl } from "../src/discovery/adapters";
import * as discovery from "../src/services/discovery";
import * as employers from "../src/services/employers";
import * as matching from "../src/services/matching";
import * as profile from "../src/services/profile";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));
beforeEach(async () => {
  await testDb().execute(sql`TRUNCATE job_evaluations, jobs, discovery_runs, job_sources, employer_assessments CASCADE`);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const LONG = "Lead end-to-end procurement of MEP packages: tender planning, RFQs, bid evaluation, negotiation and award. ".repeat(6);

function greenhouseFetch(jobsList: Array<{ id: number; title: string; location: string }>): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes("boards-api.greenhouse.io")) {
      return json({ jobs: jobsList.map((j) => ({ ...j, absolute_url: `https://boards.greenhouse.io/acme/jobs/${j.id}`, location: { name: j.location }, content: `&lt;p&gt;${LONG}&lt;/p&gt;`, updated_at: "2026-11-01T00:00:00Z" })) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("discovery adapters", () => {
  it("converts escaped HTML to text and parses Workday URLs", () => {
    expect(htmlToText("&lt;ul&gt;&lt;li&gt;Run tenders&lt;/li&gt;&lt;li&gt;Negotiate&lt;/li&gt;&lt;/ul&gt;")).toBe("• Run tenders\n• Negotiate");
    expect(parseWorkdayUrl("https://kbr.wd5.myworkdayjobs.com/en-US/KBR_Careers")).toMatchObject({ tenant: "kbr", site: "KBR_Careers" });
  });

  it("keeps procurement-family roles only", () => {
    expect(discovery.isProcurementFamily("Senior Procurement Engineer - MEP")).toBe(true);
    expect(discovery.isProcurementFamily("Contracts Manager")).toBe(true);
    expect(discovery.isProcurementFamily("Quantity Surveyor")).toBe(false);
    expect(discovery.isProcurementFamily("Talent Acquisition Partner")).toBe(false);
    expect(discovery.isProcurementFamily("Electrical Engineer")).toBe(false);
  });
});

describe("runSource", () => {
  it("adds new jobs, updates existing ones, de-duplicates and closes vanished postings", async () => {
    const db = testDb();
    const [src] = await db.insert(jobSources).values({ kind: "greenhouse", name: "Acme Giga", identifier: "acme" }).returning();
    const first = await discovery.runSource(db, src!.id, "manual", {
      fetchImpl: greenhouseFetch([
        { id: 1, title: "Senior Procurement Engineer", location: "Riyadh, Saudi Arabia" },
        { id: 2, title: "Quantity Surveyor", location: "Riyadh" },
        { id: 3, title: "Procurement Manager", location: "Jeddah" },
      ]),
    });
    expect(first).toMatchObject({ seen: 3, relevant: 2, new: 2, updated: 0 });
    const rows = await db.select().from(jobs);
    expect(rows.every((r) => r.country === "Saudi Arabia")).toBe(true);
    expect(rows[0]!.description).toContain("MEP packages");

    // Run again with job 3 gone: job 1 updated, job 3 closed.
    const second = await discovery.runSource(db, src!.id, "scheduled", { fetchImpl: greenhouseFetch([{ id: 1, title: "Senior Procurement Engineer", location: "Riyadh, Saudi Arabia" }]) });
    expect(second).toMatchObject({ new: 0, updated: 1, closed: 1 });
    const [s] = await db.select().from(jobSources).where(eq(jobSources.id, src!.id));
    expect(s!.health).toBe("healthy");
  });

  it("marks a failing source as degraded, then failing", async () => {
    const db = testDb();
    const [src] = await db.insert(jobSources).values({ kind: "greenhouse", name: "Broken", identifier: "nope" }).returning();
    const bad = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) await discovery.runSource(db, src!.id, "manual", { fetchImpl: bad }).catch(() => undefined);
    const [s] = await db.select().from(jobSources).where(eq(jobSources.id, src!.id));
    expect(s!.health).toBe("failing");
    expect(s!.consecutiveFailures).toBe(3);
  });
});

describe("employer vetting", () => {
  it("applies the PIF list and the user's employer rules", async () => {
    const neom = await employers.assessEmployer(testDb(), null, "NEOM");
    expect(neom).toMatchObject({ pifAffiliated: "yes", employerType: "client_developer", scale: "large" });
    const prefs = { excludedEmployerTypes: ["subcontractor", "small_contractor"], minEmployerScale: "large", preferredCompanies: [], excludedCompanies: ["Bad Co"] };
    expect(employers.employerGate({ employerType: "subcontractor", scale: "mid", companyName: "X" }, prefs).verdict).toBe("reject");
    expect(employers.employerGate({ employerType: "tier1_contractor", scale: "mid", companyName: "X" }, prefs).verdict).toBe("reject");
    expect(employers.employerGate({ employerType: "tier1_contractor", scale: "large", companyName: "FCC" }, prefs).verdict).toBe("allow");
    expect(employers.employerGate({ employerType: "unknown", scale: "unknown", companyName: "Mystery" }, prefs).verdict).toBe("review");
    expect(employers.employerGate({ employerType: "client_developer", scale: "large", companyName: "Bad Co." }, prefs).verdict).toBe("reject");
  });

  it("detects nationals-only postings", () => {
    expect(matching.nationalsOnly("This role is open to Saudi nationals only.", "Egyptian")).toBeTruthy();
    expect(matching.nationalsOnly("This role is open to Saudi nationals only.", "Saudi")).toBeNull();
    expect(matching.nationalsOnly("Saudi nationals are encouraged to apply.", "Egyptian")).toBeNull();
  });
});

describe("matching", () => {
  it("scores with AI, rejects by rule where it should, and reindexes without touching history", async () => {
    const db = testDb();
    const { user } = await makeUser();
    await profile.updateProfile(db, user.id, { fullName: "M", nationality: "Egyptian", preferredTitles: ["Senior Procurement Engineer"], residencyCountry: "Saudi Arabia" });
    await profile.upsertExperience(db, user.id, { employer: "X", title: "Senior Materials & Procurement Engineer", startDate: "2017-10", isCurrent: true, description: "MEP tenders" });
    const [src] = await db.insert(jobSources).values({ kind: "greenhouse", name: "NEOM", identifier: "neom" }).returning();
    const base = { sourceId: src!.id, companyName: "NEOM", employerKey: "neom", location: "Riyadh", country: "Saudi Arabia", sourceUrl: "https://x", applyUrl: "https://x", atsKind: "greenhouse", description: LONG, descriptionHash: "h" };
    await db.insert(jobs).values([
      { ...base, externalId: "a", dedupeKey: "a", title: "Senior Procurement Engineer" },
      { ...base, externalId: "b", dedupeKey: "b", title: "Procurement Manager", description: `${LONG} This position is open to Saudi nationals only.` },
      { ...base, externalId: "c", dedupeKey: "c", title: "Quantity Surveyor" },
      { ...base, externalId: "d", dedupeKey: "d", title: "Buyer", companyName: "Tiny Fitout LLC", employerKey: "tiny fitout" },
    ]);
    await db.insert(employerAssessments).values({ employerKey: "tiny fitout", companyName: "Tiny Fitout LLC", employerType: "subcontractor", scale: "small", method: "ai" });

    let aiCalls = 0;
    setAiTransportForTests(async (req) => {
      aiCalls++;
      if (req.schemaName === "employer_vetting") throw new Error("should use cache / PIF list");
      return {
        model: "test",
        content: JSON.stringify({
          score: 82,
          eligibility: "eligible",
          factors: [{ factor: "Relevant experience", score: 90, explanation: "9 years procurement" }],
          summary: "Strong fit.",
          rejectionReasons: [],
          roleFamily: "procurement",
        }),
      };
    });
    // NEOM assessment comes from the PIF list without AI
    await db.insert(employerAssessments).values({ employerKey: "neom", companyName: "NEOM", employerType: "client_developer", scale: "large", pifAffiliated: "yes", method: "rule" });

    const r = await matching.evaluateJobsForUser(db, user.id);
    expect(r).toMatchObject({ evaluated: 4, recommended: 1, rejected: 3 });
    expect(aiCalls).toBe(1);
    const evals = await matching.listMatches(db, user.id);
    const byTitle = Object.fromEntries(evals.map((x) => [x.j.title, x.e]));
    expect(byTitle["Senior Procurement Engineer"]).toMatchObject({ decision: "recommended", method: "ai", score: 90 }); // 82 + PIF 5 + client 3
    expect(byTitle["Procurement Manager"]).toMatchObject({ decision: "rejected", eligibility: "ineligible", method: "rule" });
    expect(byTitle["Quantity Surveyor"]).toMatchObject({ decision: "rejected", method: "rule" });
    expect(byTitle["Buyer"]!.summary).toContain("Subcontractor");

    // Nothing new to evaluate on a second pass
    expect((await matching.evaluateJobsForUser(db, user.id)).evaluated).toBe(0);

    // Reindex supersedes but keeps history
    expect(await matching.reindexUser(db, user.id)).toBe(4);
    const all = await db.select().from(jobEvaluations).where(eq(jobEvaluations.userId, user.id));
    expect(all).toHaveLength(4);
    expect((await matching.evaluateJobsForUser(db, user.id)).evaluated).toBe(4);
  });
});
