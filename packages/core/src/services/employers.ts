/**
 * Employer vetting: one assessment per employer (type, scale, PIF link, red
 * flags), cached and shared. The AI must answer "unknown" rather than guess;
 * a small curated list of PIF-owned companies is applied deterministically.
 */
import { eq } from "drizzle-orm";
import { employerAssessments } from "@careerflow/db";
import { aiConfigured, js, structured } from "../ai";
import { employerKey } from "../normalize";
import type { Db } from "../types";

export const EMPLOYER_TYPES = [
  "client_developer",
  "government",
  "pmc_consultant",
  "tier1_contractor",
  "subcontractor",
  "small_contractor",
  "recruitment_agency",
  "other",
  "unknown",
] as const;
export type EmployerType = (typeof EMPLOYER_TYPES)[number];

export const EMPLOYER_TYPE_LABEL: Record<string, string> = {
  client_developer: "Client / developer",
  government: "Government entity",
  pmc_consultant: "PMC / consultant",
  tier1_contractor: "Tier-1 main contractor",
  subcontractor: "Subcontractor",
  small_contractor: "Small contractor",
  recruitment_agency: "Recruitment agency",
  other: "Other",
  unknown: "Unknown",
};

/** PIF-owned or PIF-majority companies (curated; matched on normalized name). */
const PIF_COMPANIES = [
  "neom", "roshn", "red sea global", "qiddiya", "qiddiya investment company", "diriyah company", "diriyah gate development authority",
  "new murabba", "new murabba development company", "soudah development", "rua al madinah", "saudi downtown company",
  "riyadh air", "saudi entertainment ventures", "seven", "cruise saudi", "boutique group", "saudi arabian military industries", "sami",
  "enowa", "oxagon", "trojena", "the line", "red sea global hospitality", "amaala", "ma aden", "maaden", "saudi company for artificial intelligence",
  "public investment fund", "pif", "lucid", "ceer", "alat", "humain", "saudi coffee company", "events investment fund",
];

const isPif = (key: string) => PIF_COMPANIES.some((p) => key === p || key.startsWith(`${p} `));

interface AiEmployer {
  employerType: EmployerType;
  scale: "large" | "mid" | "small" | "unknown";
  pifAffiliated: "yes" | "no" | "unknown";
  summary: string;
  redFlags: string[];
  confidence: number;
}

const SCHEMA = js.obj({
  employerType: js.enumOf([...EMPLOYER_TYPES]),
  scale: js.enumOf(["large", "mid", "small", "unknown"]),
  pifAffiliated: js.enumOf(["yes", "no", "unknown"]),
  summary: js.str("One or two sentences on who the employer is"),
  redFlags: js.arr(js.str(), "Concrete concerns only, e.g. agency hiding the client, no verifiable presence"),
  confidence: js.num(),
});

const SYSTEM = `You vet employers for a senior procurement professional in Saudi Arabia / GCC construction.
Classify the employer:
- client_developer: project owner/developer (e.g. giga-project developers, real-estate developers, operators).
- government: ministry, authority, royal commission.
- pmc_consultant: project-management or engineering consultancy (e.g. AECOM, Jacobs, KBR, Parsons, Mace, Turner & Townsend).
- tier1_contractor: large main contractor/EPC on major projects (e.g. FCC, Bechtel, Nesma & Partners, El Seif, Saudi Binladin Group, CSCEC, L&T, Samsung C&T).
- subcontractor / small_contractor: specialist subcontractors, trading/supply firms, small local contractors.
- recruitment_agency: the poster is a staffing agency, not the employer.
Scale: large = national/international leader or giga-project; mid = established regional firm; small = local/small firm.
If you do not know the company with reasonable confidence, answer "unknown" for type/scale/PIF and confidence below 0.4. Never guess.
Confidence: 0-1.`;

const STALE_DAYS = 90;

export async function getAssessment(db: Db, companyName: string) {
  const [row] = await db.select().from(employerAssessments).where(eq(employerAssessments.employerKey, employerKey(companyName)));
  return row ?? null;
}

export async function assessEmployer(db: Db, userId: string | null, companyName: string, context?: string) {
  const key = employerKey(companyName);
  const cached = await getAssessment(db, companyName);
  if (cached && Date.now() - cached.assessedAt.getTime() < STALE_DAYS * 86_400_000) return cached;

  let a: AiEmployer = { employerType: "unknown", scale: "unknown", pifAffiliated: "unknown", summary: "Not assessed (AI not connected).", redFlags: [], confidence: 0 };
  let method: "ai" | "rule" = "rule";
  let decisionId: string | null = null;
  if (aiConfigured() && userId) {
    const r = await structured<AiEmployer>({
      db,
      userId,
      stage: "employer_vetting",
      agent: "career_matching",
      inputSummary: companyName,
      system: SYSTEM,
      user: `Employer name as posted: ${companyName}\n${context ? `Context from a posting:\n"""\n${context.slice(0, 2500)}\n"""` : ""}`,
      schemaName: "employer_vetting",
      schema: SCHEMA,
      maxOutputTokens: 1500,
      outcome: (d) => `${d.employerType}/${d.scale}`,
    });
    a = r.data;
    method = "ai";
    decisionId = r.decisionId;
  }
  if (isPif(key)) {
    a = { ...a, pifAffiliated: "yes", scale: a.scale === "unknown" ? "large" : a.scale, employerType: a.employerType === "unknown" ? "client_developer" : a.employerType };
  }
  const values = {
    employerKey: key,
    companyName,
    employerType: a.employerType,
    scale: a.scale,
    pifAffiliated: a.pifAffiliated,
    summary: a.summary,
    redFlags: a.redFlags.slice(0, 6),
    confidence: Math.max(0, Math.min(1, a.confidence)).toFixed(3),
    method,
    aiDecisionId: decisionId,
    assessedAt: new Date(),
  };
  const [row] = await db
    .insert(employerAssessments)
    .values(values)
    .onConflictDoUpdate({ target: employerAssessments.employerKey, set: values })
    .returning();
  return row!;
}

/**
 * Deterministic gate from the user's employer preferences.
 * Returns a rejection reason, "review" when the employer is unknown, or null when allowed.
 */
export function employerGate(
  a: { employerType: string; scale: string; companyName: string },
  prefs: { excludedEmployerTypes: string[]; minEmployerScale: string; preferredCompanies: string[]; excludedCompanies: string[] },
): { verdict: "allow" | "reject" | "review"; reason?: string } {
  const key = employerKey(a.companyName);
  if (prefs.excludedCompanies.some((c) => employerKey(c) === key)) return { verdict: "reject", reason: "You asked never to apply to this company." };
  if (prefs.preferredCompanies.some((c) => employerKey(c) === key)) return { verdict: "allow" };
  if (prefs.excludedEmployerTypes.includes(a.employerType)) {
    return { verdict: "reject", reason: `${EMPLOYER_TYPE_LABEL[a.employerType]} — excluded by your employer preferences.` };
  }
  const rank: Record<string, number> = { small: 1, mid: 2, large: 3 };
  if (a.scale !== "unknown" && prefs.minEmployerScale !== "any" && (rank[a.scale] ?? 0) < (rank[prefs.minEmployerScale] ?? 0)) {
    return { verdict: "reject", reason: `Company size (${a.scale}) is below your minimum (${prefs.minEmployerScale}).` };
  }
  if (a.employerType === "unknown" || a.scale === "unknown") return { verdict: "review", reason: "Employer couldn't be verified — confirm before applying." };
  return { verdict: "allow" };
}
