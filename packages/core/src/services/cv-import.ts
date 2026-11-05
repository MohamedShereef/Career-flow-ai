/**
 * "Fill my profile from my CV": AI reads the uploaded CV and proposes profile
 * entries; nothing is written until the user reviews and selects items.
 * Numbers become *draft* highlights that still need explicit verification.
 */
import { and, desc, eq } from "drizzle-orm";
import { cvExtractions, documents } from "@careerflow/db";
import { js, structured } from "../ai";
import { extractDocumentText } from "../cv-text";
import { AppError, notFound } from "../errors";
import type { Db } from "../types";
import { audit } from "./audit";
import { getDocumentForDownload } from "./documents";
import * as profile from "./profile";

export interface ExtractedCv {
  fullName: string | null;
  headline: string | null;
  summary: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  city: string | null;
  nationality: string | null;
  yearsExperience: number | null;
  experiences: Array<{
    employer: string;
    title: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    description: string;
  }>;
  qualifications: Array<{
    kind: "degree" | "certification" | "course" | "membership";
    name: string;
    issuer: string | null;
    state: "held" | "in_progress";
    obtainedOn: string | null;
  }>;
  skills: string[];
  highlights: Array<{
    category: "achievement" | "contract_value" | "team_size" | "savings" | "package" | "other";
    statement: string;
    numericValue: number | null;
    unit: string | null;
  }>;
  warnings: string[];
}

const SCHEMA = js.obj({
  fullName: js.strN(),
  headline: js.strN("Current job title as written in the CV"),
  summary: js.strN("The CV's own profile/summary paragraph, verbatim or lightly cleaned"),
  email: js.strN(),
  phone: js.strN(),
  linkedinUrl: js.strN(),
  city: js.strN(),
  nationality: js.strN("Only if the CV states it explicitly"),
  yearsExperience: js.numN(),
  experiences: js.arr(
    js.obj({
      employer: js.str(),
      title: js.str(),
      location: js.strN(),
      startDate: js.strN("YYYY-MM, null if the CV gives no start month/year"),
      endDate: js.strN("YYYY-MM, null if current or not stated"),
      isCurrent: js.bool(),
      description: js.str("Responsibilities and achievements for this role, one bullet per line, wording kept from the CV"),
    }),
  ),
  qualifications: js.arr(
    js.obj({
      kind: js.enumOf(["degree", "certification", "course", "membership"]),
      name: js.str(),
      issuer: js.strN(),
      state: js.enumOf(["held", "in_progress"]),
      obtainedOn: js.strN("YYYY-MM-DD if stated (use -01 for unknown day), else null"),
    }),
  ),
  skills: js.arr(js.str()),
  highlights: js.arr(
    js.obj({
      category: js.enumOf(["achievement", "contract_value", "team_size", "savings", "package", "other"]),
      statement: js.str("A measurable achievement exactly as the CV states it"),
      numericValue: js.numN(),
      unit: js.strN(),
    }),
  ),
  warnings: js.arr(js.str(), "Inconsistencies you noticed (overlapping dates, unclear figures). Do not fix them."),
});

const SYSTEM = `You extract structured data from a CV for the candidate's own profile.
Rules:
- Use ONLY what the CV explicitly says. Never infer, embellish, translate titles, or fill gaps.
- If a field is not stated, return null (or an empty list).
- Dates: convert to YYYY-MM. If only a year is given, use YYYY-01 and add a warning.
- Mark a qualification "in_progress" if the CV says studying, pursuing, candidate, ongoing, or expected.
- Highlights: only achievements that contain a concrete number or a clearly measurable outcome. Copy the figure exactly; do not convert currencies.
- Skills: short noun phrases (tools, methods, domains) that appear in the CV.
- Warnings: only real problems the candidate must fix (overlapping jobs by more than a month, a figure that is unclear, a date that contradicts another).
  Do NOT warn about: a year-only date, one job ending in the same month the next starts, "9+ years" stored as 9, or dates before today.`;

export async function extractFromCv(db: Db, userId: string, documentId: string) {
  const { doc, bytes } = await getDocumentForDownload(db, userId, documentId);
  if (doc.kind !== "cv_original") throw new AppError("not_cv", "Choose one of your uploaded CVs.");
  const [row] = await db.insert(cvExtractions).values({ userId, documentId, status: "pending" }).returning();
  try {
    const text = await extractDocumentText(bytes, doc.mimeType);
    const { data, decisionId } = await structured<ExtractedCv>({
      db,
      userId,
      stage: "cv_extraction",
      agent: "cv_tailoring",
      entityType: "document",
      entityId: documentId,
      inputSummary: `CV ${doc.filename}, ${text.length} chars`,
      system: `${SYSTEM}\nToday's date is ${new Date().toISOString().slice(0, 10)}. Anything dated before today is in the past.`,
      user: `CV text:\n"""\n${text}\n"""`,
      schemaName: "cv_extraction",
      schema: SCHEMA,
      maxOutputTokens: 12000,
      outcome: (d) => `${d.experiences.length} roles, ${d.qualifications.length} qualifications, ${d.skills.length} skills, ${d.highlights.length} highlights`,
    });
    await db.update(cvExtractions).set({ status: "extracted", extracted: data, aiDecisionId: decisionId }).where(eq(cvExtractions.id, row!.id));
    return { id: row!.id, data };
  } catch (err) {
    const reason = err instanceof AppError ? err.userMessage : err instanceof Error ? err.message : String(err);
    await db.update(cvExtractions).set({ status: "failed", extracted: { error: reason.slice(0, 300) } }).where(eq(cvExtractions.id, row!.id));
    throw err;
  }
}

export async function getExtraction(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ x: cvExtractions, filename: documents.filename })
    .from(cvExtractions)
    .innerJoin(documents, eq(documents.id, cvExtractions.documentId))
    .where(and(eq(cvExtractions.id, id), eq(cvExtractions.userId, userId)));
  if (!row) throw notFound("CV import");
  return { ...row.x, filename: row.filename, data: row.x.status === "failed" ? null : (row.x.extracted as ExtractedCv | null) };
}

export async function latestExtraction(db: Db, userId: string) {
  const [row] = await db
    .select({ id: cvExtractions.id, status: cvExtractions.status, createdAt: cvExtractions.createdAt })
    .from(cvExtractions)
    .where(eq(cvExtractions.userId, userId))
    .orderBy(desc(cvExtractions.createdAt))
    .limit(1);
  return row ?? null;
}

export interface ImportSelection {
  profileFields: string[];
  experiences: number[];
  qualifications: number[];
  skills: string[];
  highlights: number[];
}

/** "2017" → "2017-01", "2017-03-15" → "2017-03", anything else → null. */
function ym(v: string | null | undefined): string | null {
  const m = (v ?? "").trim().match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return null;
  const month = Math.min(12, Math.max(1, Number(m[2] ?? 1)));
  return `${m[1]}-${String(month).padStart(2, "0")}`;
}
function ymd(v: string | null | undefined): string | null {
  const d = (v ?? "").trim().match(/^\d{4}-\d{2}-\d{2}$/) ? v!.trim() : null;
  if (d) return d;
  const m = ym(v);
  return m ? `${m}-01` : null;
}
function linkedin(v: string | null): string | null {
  if (!v) return null;
  const m = v.replace(/\s+/g, "").match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,;]+/i);
  if (!m) return null;
  return /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`;
}
const cut = (v: string | null | undefined, n: number) => (v == null ? v : v.trim().slice(0, n));

const PROFILE_FIELDS = ["fullName", "headline", "summary", "phone", "contactEmail", "linkedinUrl", "city", "nationality", "yearsExperience"] as const;

export async function applyExtraction(db: Db, userId: string, id: string, sel: ImportSelection) {
  const x = await getExtraction(db, userId, id);
  if (!x.data || x.status === "failed") throw new AppError("not_ready", "This CV import has no data to apply.");
  const d = x.data;
  const report = { profileFields: 0, experiences: 0, qualifications: 0, skills: 0, highlights: 0, skipped: [] as string[] };

  // Profile fields
  const fieldMap: Record<(typeof PROFILE_FIELDS)[number], unknown> = {
    fullName: d.fullName,
    headline: d.headline,
    summary: d.summary,
    phone: d.phone,
    contactEmail: d.email?.trim().toLowerCase() ?? null,
    linkedinUrl: linkedin(d.linkedinUrl),
    city: cut(d.city, 100),
    nationality: cut(d.nationality, 80),
    yearsExperience: d.yearsExperience,
  };
  // One field at a time, so a single odd value never blocks the rest.
  for (const f of PROFILE_FIELDS) {
    if (!sel.profileFields.includes(f)) continue;
    const v = fieldMap[f];
    if (v == null || v === "") {
      if (f === "linkedinUrl" && d.linkedinUrl) report.skipped.push(`LinkedIn: "${d.linkedinUrl.slice(0, 60)}" isn't a linkedin.com link — paste the full link in Personal details.`);
      continue;
    }
    try {
      await profile.updateProfile(db, userId, { [f]: v });
      report.profileFields++;
    } catch (err) {
      report.skipped.push(`${f}: ${err instanceof AppError ? err.userMessage : "invalid value"}`);
    }
  }

  // Experiences (skip ones already on the profile)
  const existing = await profile.listExperiences(db, userId);
  const key = (e: { employer: string; title: string; startDate: string | null }) =>
    `${e.employer.trim().toLowerCase()}|${e.title.trim().toLowerCase()}|${(e.startDate ?? "").slice(0, 7)}`;
  const have = new Set(existing.map((e) => key(e)));
  for (const i of sel.experiences) {
    const raw = d.experiences[i];
    if (!raw) continue;
    const e = {
      ...raw,
      employer: cut(raw.employer, 150) ?? "",
      title: cut(raw.title, 150) ?? "",
      location: cut(raw.location, 120) ?? null,
      startDate: ym(raw.startDate),
      endDate: raw.isCurrent ? null : ym(raw.endDate),
    };
    if (!e.startDate) {
      report.skipped.push(`${e.title} at ${e.employer}: the CV has no start date — add it manually.`);
      continue;
    }
    if (have.has(key(e))) {
      report.skipped.push(`${e.title} at ${e.employer}: already on your profile.`);
      continue;
    }
    try {
      await profile.upsertExperience(db, userId, { ...e, description: (e.description ?? "").slice(0, 5000) });
      have.add(key(e));
      report.experiences++;
    } catch (err) {
      report.skipped.push(`${e.title} at ${e.employer}: ${err instanceof AppError ? err.userMessage : "invalid dates"}`);
    }
  }

  const existingQuals = new Set((await profile.listQualifications(db, userId)).map((q) => q.name.trim().toLowerCase()));
  for (const i of sel.qualifications) {
    const q = d.qualifications[i];
    if (!q || existingQuals.has(q.name.trim().toLowerCase())) continue;
    try {
      await profile.addQualification(db, userId, { ...q, name: q.name.trim().slice(0, 200), issuer: cut(q.issuer, 150) ?? null, obtainedOn: ymd(q.obtainedOn) });
      existingQuals.add(q.name.trim().toLowerCase());
      report.qualifications++;
    } catch (err) {
      report.skipped.push(`${q.name}: ${err instanceof AppError ? err.userMessage : "invalid details"}.`);
    }
  }

  const chosenSkills = d.skills.filter((s) => sel.skills.includes(s));
  report.skills = (await profile.addSkills(db, userId, chosenSkills)).length;

  for (const i of sel.highlights) {
    const h = d.highlights[i];
    if (!h) continue;
    try {
      await profile.addCareerFact(db, userId, { category: h.category, statement: h.statement, numericValue: h.numericValue, unit: h.unit }, "cv_extraction");
      report.highlights++;
    } catch {
      report.skipped.push(`Highlight "${h.statement.slice(0, 60)}…": couldn't be saved.`);
    }
  }

  await db.update(cvExtractions).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(cvExtractions.id, id));
  await audit(db, { userId, actor: "user", action: "cv.import_applied", entityType: "cv_extraction", entityId: id, metadata: report });
  return report;
}
