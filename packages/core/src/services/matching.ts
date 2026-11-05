/**
 * Career Matching Agent. Deterministic gates first (excluded companies,
 * employer type/scale, nationals-only roles), then an explainable AI score on
 * the full description. Results are versioned by profile + description hash,
 * so "Fresh reindex" never touches applications or saved answers.
 */
import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { jobEvaluations, jobs } from "@careerflow/db";
import { aiConfigured, js, structured } from "../ai";
import { AppError } from "../errors";
import type { Db } from "../types";
import { isProcurementFamily } from "./discovery";
import { assessEmployer, employerGate, EMPLOYER_TYPE_LABEL } from "./employers";
import * as feedback from "./feedback";
import * as profile from "./profile";
import { getSettings } from "./settings";

const NATIONALS_ONLY = /\b(saudi nationals? only|only saudi|saudis only|for saudi nationals|saudi national(s)? required|open to saudi nationals only|ksa nationals? only|gcc nationals? only|emirati nationals? only|uae nationals? only|qatari nationals? only|kuwaiti nationals? only)\b|\bsaudization\b|\(saudi\)|\bksa national\b/i;

export function nationalsOnly(text: string, nationality: string | null): string | null {
  if (!NATIONALS_ONLY.test(text)) return null;
  const nat = (nationality ?? "").toLowerCase();
  if (/saudi/.test(text.toLowerCase()) && /saudi/.test(nat)) return null;
  if (/gcc/.test(text.toLowerCase()) && /(saudi|emirati|qatari|kuwaiti|bahraini|omani)/.test(nat)) return null;
  return "The posting is restricted to nationals, and your nationality doesn't qualify.";
}

interface AiMatch {
  score: number;
  eligibility: "eligible" | "ineligible" | "uncertain";
  factors: Array<{ factor: string; score: number; explanation: string }>;
  summary: string;
  rejectionReasons: string[];
  roleFamily: string;
}

const FACTORS = [
  "Relevant experience",
  "Seniority & management",
  "Industry & discipline",
  "Skills & certifications",
  "Location & eligibility",
  "Employment conditions & salary",
  "Employer & career progression",
];

const SCHEMA = js.obj({
  score: js.num(),
  eligibility: js.enumOf(["eligible", "ineligible", "uncertain"]),
  factors: js.arr(js.obj({ factor: js.enumOf(FACTORS), score: js.num(), explanation: js.str() })),
  summary: js.str("2-3 sentences: why this is or isn't a good match"),
  rejectionReasons: js.arr(js.str()),
  roleFamily: js.str("e.g. procurement, contracts, supply chain, quantity surveying, HR, engineering discipline"),
});

const SYSTEM = `You evaluate one job posting for one candidate. Be realistic and specific.
- Read the FULL description, not keywords. A role is only relevant if its core duties are procurement, purchasing, sourcing, supply chain, materials management, or contracts/commercial work with real procurement responsibility.
- Quantity Surveyor, Talent Acquisition, design/engineering-discipline roles and similar are NOT matches even if they mention construction or tenders.
- Seniority: compare required years/level with the candidate's actual experience; over- and under-qualification both lower the score.
- Eligibility: "ineligible" if the posting requires a nationality, residency, licence or language the candidate does not have; "uncertain" if unclear.
- Use only facts in the candidate profile. Don't assume skills they haven't listed.
- Score 0-100 overall; also score each factor 0-100 with a one-sentence explanation.`;

export interface MatchRunResult {
  evaluated: number;
  recommended: number;
  rejected: number;
  review: number;
  skipped: number;
}

export async function evaluateJobsForUser(db: Db, userId: string, opts: { limit?: number; staleBefore?: Date; rescoreDecisions?: string[] } = {}): Promise<MatchRunResult> {
  const limit = opts.limit ?? Number(process.env.MAX_EVALUATIONS_PER_RUN ?? 40);
  const [p, settings, exps, quals, skills, facts] = await Promise.all([
    profile.getProfile(db, userId),
    getSettings(db, userId),
    profile.listExperiences(db, userId),
    profile.listQualifications(db, userId),
    profile.listSkills(db, userId),
    profile.listCareerFacts(db, userId, true),
  ]);
  const res: MatchRunResult = { evaluated: 0, recommended: 0, rejected: 0, review: 0, skipped: 0 };

  // Active jobs with no current evaluation for this profile version / description.
  const candidates = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "active"),
        notExists(
          db
            .select({ x: sql`1` })
            .from(jobEvaluations)
            .where(
              and(
                eq(jobEvaluations.jobId, jobs.id),
                eq(jobEvaluations.userId, userId),
                isNull(jobEvaluations.supersededAt),
                eq(jobEvaluations.profileVersion, p.profileVersion),
                sql`${jobEvaluations.jobDescriptionHash} IS NOT DISTINCT FROM ${jobs.descriptionHash}`,
                opts.staleBefore ? sql`${jobEvaluations.createdAt} >= ${opts.staleBefore.toISOString()}` : undefined,
              ),
            ),
        ),
        // Learning re-scores only what's currently recommended / for review; the user's own "not interested" is final.
        opts.rescoreDecisions?.length
          ? sql`EXISTS (SELECT 1 FROM job_evaluations je WHERE je.job_id = ${jobs.id} AND je.user_id = ${userId} AND je.superseded_at IS NULL AND je.decision::text IN (${sql.join(opts.rescoreDecisions.map((d) => sql`${d}`), sql`, `)}))`
          : undefined,
        sql`NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.job_id = ${jobs.id} AND f.user_id = ${userId} AND f.signal = 'not_interested')`,
      ),
    )
    .orderBy(desc(jobs.firstSeenAt))
    .limit(limit * 3);

  const [learned, ruledOut] = await Promise.all([feedback.learnedContext(db, userId), feedback.ruledOutEmployers(db, userId)]);
  const candidateProfile = {
    headline: p.headline,
    yearsExperience: p.yearsExperience,
    nationality: p.nationality,
    residencyCountry: p.residencyCountry,
    residencyDetails: p.residencyDetails,
    preferredTitles: p.preferredTitles,
    preferredLocations: p.preferredLocations,
    expectedSalary: p.expectedSalary ? `${p.expectedSalary} ${p.salaryCurrency ?? ""} ${p.salaryFrequency ?? ""}`.trim() : null,
    noticePeriodDays: p.noticePeriodDays,
    experiences: exps.map((e) => ({ title: e.title, employer: e.employer, start: e.startDate, end: e.isCurrent ? "present" : e.endDate, description: e.description?.slice(0, 1500) })),
    qualifications: quals.map((q) => `${q.name}${q.state === "in_progress" ? " (in progress)" : ""}`),
    skills: skills.map((s) => s.name),
    verifiedHighlights: facts.map((f) => f.statement),
  };

  const write = async (job: typeof jobs.$inferSelect, v: { score: number; decision: "recommended" | "rejected" | "needs_review"; eligibility: "eligible" | "ineligible" | "uncertain"; breakdown: unknown; summary: string; rejectionReasons: string[]; method: "ai" | "rule"; aiDecisionId?: string | null }) => {
    await db.transaction(async (tx) => {
      await tx
        .update(jobEvaluations)
        .set({ supersededAt: new Date() })
        .where(and(eq(jobEvaluations.userId, userId), eq(jobEvaluations.jobId, job.id), isNull(jobEvaluations.supersededAt)));
      await tx.insert(jobEvaluations).values({
        userId,
        jobId: job.id,
        profileVersion: p.profileVersion,
        jobDescriptionHash: job.descriptionHash,
        score: Math.round(Math.max(0, Math.min(100, v.score))),
        decision: v.decision,
        eligibility: v.eligibility,
        breakdown: v.breakdown,
        summary: v.summary,
        rejectionReasons: v.rejectionReasons,
        method: v.method,
        aiDecisionId: v.aiDecisionId ?? null,
      });
    });
    res[v.decision === "recommended" ? "recommended" : v.decision === "rejected" ? "rejected" : "review"]++;
  };

  for (const job of candidates) {
    if (res.evaluated >= limit) break;
    res.evaluated++;

    if (!isProcurementFamily(job.title)) {
      await write(job, { score: 0, decision: "rejected", eligibility: "uncertain", breakdown: [], summary: "Title is outside the procurement / contracts / supply-chain family.", rejectionReasons: ["Not a procurement-family role"], method: "rule" });
      continue;
    }
    const restricted = nationalsOnly(`${job.title}\n${job.description ?? ""}`, p.nationality);
    if (restricted) {
      await write(job, { score: 0, decision: "rejected", eligibility: "ineligible", breakdown: [], summary: restricted, rejectionReasons: [restricted], method: "rule" });
      continue;
    }

    if (ruledOut.has(job.employerKey)) {
      await write(job, { score: 0, decision: "rejected", eligibility: "uncertain", breakdown: [], summary: "You said you're not interested in this employer.", rejectionReasons: ["Employer you ruled out"], method: "rule" });
      continue;
    }
    const employer = await assessEmployer(db, userId, job.companyName, job.description ?? undefined);
    const gate = employerGate(employer, p);
    const employerInfo = { type: EMPLOYER_TYPE_LABEL[employer.employerType], scale: employer.scale, pif: employer.pifAffiliated, redFlags: employer.redFlags };
    if (gate.verdict === "reject") {
      await write(job, { score: 0, decision: "rejected", eligibility: "uncertain", breakdown: [{ factor: "Employer & career progression", score: 0, explanation: gate.reason }], summary: gate.reason!, rejectionReasons: [gate.reason!], method: "rule" });
      continue;
    }

    if (!aiConfigured()) {
      res.skipped++;
      res.evaluated--;
      continue;
    }
    if (!job.description) {
      await write(job, { score: 0, decision: "needs_review", eligibility: "uncertain", breakdown: [], summary: "The job board didn't provide a description, so the match couldn't be assessed. Open the posting to check.", rejectionReasons: [], method: "rule" });
      continue;
    }

    try {
      const { data, decisionId } = await structured<AiMatch>({
        db,
        userId,
        stage: "matching",
        agent: "career_matching",
        entityType: "job",
        entityId: job.id,
        inputSummary: `${job.title} @ ${job.companyName} (${job.location ?? "?"})`,
        system: SYSTEM,
        user:
          `CANDIDATE:\n${JSON.stringify(candidateProfile)}\n\nEMPLOYER ASSESSMENT: ${JSON.stringify(employerInfo)}\n` +
          (learned ? `\nLEARNED FROM THE CANDIDATE'S OWN DECISIONS (weigh similar jobs the same way; say so in a factor if it changed the score):\n${learned}\n` : "") +
          `Candidate prefers client-side and PIF-affiliated employers; large tier-1 contractors are acceptable.\n\n` +
          `JOB: ${job.title} at ${job.companyName}\nLocation: ${job.location ?? "not stated"}\nType: ${job.employmentType ?? "not stated"}\n` +
          `Salary: ${job.salaryMin || job.salaryMax ? `${job.salaryMin ?? "?"}-${job.salaryMax ?? "?"} ${job.salaryCurrency ?? ""}` : "not published"}\n\nDESCRIPTION:\n"""\n${job.description.slice(0, 12_000)}\n"""`,
        schemaName: "job_match",
        schema: SCHEMA,
        maxOutputTokens: 3000,
        outcome: (d) => `score ${Math.round(d.score)} · ${d.eligibility}`,
      });
      let score = data.score;
      // Preference boost is explicit and bounded so it can't turn a poor match into a good one.
      const boost = (p.preferPif && employer.pifAffiliated === "yes" ? 5 : 0) + (["client_developer", "government"].includes(employer.employerType) ? 3 : 0);
      score = Math.min(100, score + (score >= 40 ? boost : 0));
      const decision =
        data.eligibility === "ineligible" ? "rejected" : score < settings.matchThreshold ? "rejected" : data.eligibility === "uncertain" || gate.verdict === "review" ? "needs_review" : "recommended";
      const reasons = [...data.rejectionReasons];
      if (gate.verdict === "review" && gate.reason) reasons.push(gate.reason);
      await write(job, {
        score,
        decision,
        eligibility: data.eligibility,
        breakdown: [...data.factors, ...(boost && score >= 40 ? [{ factor: "Preference boost", score: boost, explanation: "Client-side / PIF employer preference" }] : [])],
        summary: data.summary,
        rejectionReasons: decision === "recommended" ? [] : reasons,
        method: "ai",
        aiDecisionId: decisionId,
      });
    } catch (err) {
      if (err instanceof AppError && ["ai_rate_limited", "ai_auth", "ai_unavailable"].includes(err.code)) throw err; // stop the run; retried later
      res.skipped++;
    }
  }
  return res;
}

/**
 * Fresh reindex: every current evaluation made before now counts as stale and is
 * re-scored. Old results stay visible until each one is replaced, so the list never
 * empties; history and applications are untouched.
 */
export async function reindexUser(db: Db, userId: string) {
  const staleBefore = new Date();
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(and(eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt), eq(jobs.status, "active")));
  return { count: r?.n ?? 0, staleBefore };
}

/** True while a scoring run that covers this user is queued or running. */
export async function matchingInProgress(db: Db, userId: string) {
  const r = await db.execute(
    sql`SELECT 1 FROM tasks WHERE status IN ('queued','running') AND run_at <= now() + interval '5 minutes'
        AND (kind = 'matching.run_all' OR (kind = 'matching.run_user' AND payload->>'userId' = ${userId})) LIMIT 1`,
  );
  return r.rows.length > 0;
}

export async function listMatches(db: Db, userId: string, decision?: "recommended" | "rejected" | "needs_review") {
  return db
    .select({ e: jobEvaluations, j: jobs })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(and(eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt), eq(jobs.status, "active"), decision ? eq(jobEvaluations.decision, decision) : undefined))
    .orderBy(desc(jobEvaluations.score), desc(jobs.firstSeenAt))
    .limit(200);
}

export async function matchCounts(db: Db, userId: string) {
  const rows = await db
    .select({ d: jobEvaluations.decision, n: sql<number>`count(*)::int` })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(and(eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt), eq(jobs.status, "active")))
    .groupBy(jobEvaluations.decision);
  const get = (d: string) => rows.find((r) => r.d === d)?.n ?? 0;
  return { recommended: get("recommended"), needs_review: get("needs_review"), rejected: get("rejected") };
}

export async function getMatch(db: Db, userId: string, jobId: string) {
  const [row] = await db
    .select({ e: jobEvaluations, j: jobs })
    .from(jobs)
    .leftJoin(jobEvaluations, and(eq(jobEvaluations.jobId, jobs.id), eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt)))
    .where(eq(jobs.id, jobId));
  return row ?? null;
}

