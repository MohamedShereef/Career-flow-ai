import { and, asc, desc, eq, sql } from "drizzle-orm";
import { applicantProfiles, careerFacts, qualifications, skills, workExperiences } from "@careerflow/db";
import { z } from "zod";
import { decryptNullable, encryptNullable } from "../crypto";
import { AppError, notFound } from "../errors";
import type { Db, Executor } from "../types";
import { audit } from "./audit";

const aad = (userId: string, field: string) => `profile:${userId}:${field}`;

const list = z
  .array(z.string().trim().min(1).max(120))
  .max(30)
  .transform((a) => [...new Set(a)]);

export const profileUpdateSchema = z
  .object({
    fullName: z.string().trim().max(150).nullable(),
    headline: z.string().trim().max(200).nullable(),
    summary: z.string().trim().max(4000).nullable(),
    nationality: z.string().trim().max(80).nullable(),
    residencyCountry: z.string().trim().max(80).nullable(),
    residencyDetails: z.string().trim().max(300).nullable(),
    city: z.string().trim().max(100).nullable(),
    phone: z.string().trim().max(40).nullable(),
    contactEmail: z.string().trim().email().max(254).nullable(),
    linkedinUrl: z.string().trim().url().max(300).nullable(),
    yearsExperience: z.coerce.number().min(0).max(60).nullable(),
    noticePeriodDays: z.coerce.number().int().min(0).max(365).nullable(),
    availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    currentSalary: z.string().trim().max(60).nullable(),
    expectedSalary: z.string().trim().max(60).nullable(),
    salaryCurrency: z.string().trim().max(10).nullable(),
    salaryFrequency: z.enum(["monthly", "annual"]).nullable(),
    preferredTitles: list,
    preferredLocations: list,
    preferredCompanies: list,
    excludedCompanies: list,
    workArrangements: list,
    industries: list,
    preferredEmployerTypes: z.array(z.enum(["client_developer", "government", "pmc_consultant", "tier1_contractor", "subcontractor", "small_contractor", "recruitment_agency"])),
    excludedEmployerTypes: z.array(z.enum(["client_developer", "government", "pmc_consultant", "tier1_contractor", "subcontractor", "small_contractor", "recruitment_agency"])),
    minEmployerScale: z.enum(["large", "mid", "any"]),
    preferPif: z.boolean(),
  })
  .partial();

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export async function getProfile(db: Executor, userId: string) {
  const [p] = await db.select().from(applicantProfiles).where(eq(applicantProfiles.userId, userId));
  if (!p) throw notFound("Profile");
  const { phoneEnc, currentSalaryEnc, expectedSalaryEnc, residencyDetailsEnc, ...rest } = p;
  return {
    ...rest,
    yearsExperience: rest.yearsExperience === null ? null : Number(rest.yearsExperience),
    phone: decryptNullable(phoneEnc, aad(userId, "phone")),
    currentSalary: decryptNullable(currentSalaryEnc, aad(userId, "current_salary")),
    expectedSalary: decryptNullable(expectedSalaryEnc, aad(userId, "expected_salary")),
    residencyDetails: decryptNullable(residencyDetailsEnc, aad(userId, "residency")),
  };
}
export type Profile = Awaited<ReturnType<typeof getProfile>>;

export async function updateProfile(db: Db, userId: string, input: unknown) {
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("invalid_profile", `Check the field “${issue?.path.join(".")}”: ${issue?.message}`);
  }
  const d = parsed.data;
  const { phone, currentSalary, expectedSalary, residencyDetails, yearsExperience, ...plain } = d;
  const values: Partial<typeof applicantProfiles.$inferInsert> = { ...plain, updatedAt: new Date() };
  if ("phone" in d) values.phoneEnc = encryptNullable(phone, aad(userId, "phone"));
  if ("currentSalary" in d) values.currentSalaryEnc = encryptNullable(currentSalary, aad(userId, "current_salary"));
  if ("expectedSalary" in d) values.expectedSalaryEnc = encryptNullable(expectedSalary, aad(userId, "expected_salary"));
  if ("residencyDetails" in d) values.residencyDetailsEnc = encryptNullable(residencyDetails, aad(userId, "residency"));
  if ("yearsExperience" in d) values.yearsExperience = yearsExperience === null || yearsExperience === undefined ? null : String(yearsExperience);

  await db
    .update(applicantProfiles)
    .set({ ...values, profileVersion: sql`${applicantProfiles.profileVersion} + 1` })
    .where(eq(applicantProfiles.userId, userId));
  await audit(db, { userId, actor: "user", action: "profile.updated", metadata: { fields: Object.keys(d) } });
  return getProfile(db, userId);
}

async function bumpProfileVersion(db: Executor, userId: string) {
  await db
    .update(applicantProfiles)
    .set({ profileVersion: sql`${applicantProfiles.profileVersion} + 1`, updatedAt: new Date() })
    .where(eq(applicantProfiles.userId, userId));
}

// ── Work experience ──

export const experienceSchema = z
  .object({
    employer: z.string().trim().min(1).max(150),
    title: z.string().trim().min(1).max(150),
    location: z.string().trim().max(120).nullish(),
    startDate: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
    endDate: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).nullish(),
    isCurrent: z.boolean().default(false),
    description: z.string().trim().max(5000).nullish(),
  })
  .transform((v) => ({
    ...v,
    startDate: v.startDate.length === 7 ? `${v.startDate}-01` : v.startDate,
    endDate: v.isCurrent || !v.endDate ? null : v.endDate.length === 7 ? `${v.endDate}-01` : v.endDate,
  }))
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { message: "End date must be after start date." });

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, code: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError(code, r.error.issues[0]?.message ?? "Invalid input.");
  return r.data;
}

export async function listExperiences(db: Executor, userId: string) {
  return db
    .select()
    .from(workExperiences)
    .where(eq(workExperiences.userId, userId))
    .orderBy(desc(workExperiences.isCurrent), desc(workExperiences.startDate));
}

export async function upsertExperience(db: Db, userId: string, input: unknown, id?: string) {
  const v = parseOrThrow(experienceSchema, input, "invalid_experience");
  let row;
  if (id) {
    [row] = await db
      .update(workExperiences)
      .set({ ...v, updatedAt: new Date() })
      .where(and(eq(workExperiences.id, id), eq(workExperiences.userId, userId)))
      .returning();
    if (!row) throw notFound("Experience");
  } else {
    [row] = await db.insert(workExperiences).values({ ...v, userId }).returning();
  }
  await bumpProfileVersion(db, userId);
  return row!;
}

export async function deleteExperience(db: Db, userId: string, id: string) {
  const res = await db
    .delete(workExperiences)
    .where(and(eq(workExperiences.id, id), eq(workExperiences.userId, userId)))
    .returning({ id: workExperiences.id });
  if (!res.length) throw notFound("Experience");
  await bumpProfileVersion(db, userId);
}

// ── Qualifications ──

export const qualificationSchema = z.object({
  kind: z.enum(["degree", "certification", "course", "membership"]),
  name: z.string().trim().min(1).max(200),
  issuer: z.string().trim().max(150).nullish(),
  state: z.enum(["held", "in_progress", "expired"]).default("held"),
  obtainedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  credentialId: z.string().trim().max(100).nullish(),
});

export async function listQualifications(db: Executor, userId: string) {
  return db.select().from(qualifications).where(eq(qualifications.userId, userId)).orderBy(asc(qualifications.kind), desc(qualifications.obtainedOn));
}

export async function addQualification(db: Db, userId: string, input: unknown) {
  const v = parseOrThrow(qualificationSchema, input, "invalid_qualification");
  const [row] = await db.insert(qualifications).values({ ...v, userId }).returning();
  await bumpProfileVersion(db, userId);
  return row!;
}

export async function deleteQualification(db: Db, userId: string, id: string) {
  const res = await db.delete(qualifications).where(and(eq(qualifications.id, id), eq(qualifications.userId, userId))).returning();
  if (!res.length) throw notFound("Qualification");
  await bumpProfileVersion(db, userId);
}

// ── Skills ──

export async function listSkills(db: Executor, userId: string) {
  return db.select().from(skills).where(eq(skills.userId, userId)).orderBy(asc(skills.category), asc(skills.name));
}

export async function addSkills(db: Db, userId: string, names: string[], category?: string | null) {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 80))].slice(0, 50);
  if (!clean.length) return [];
  const rows = await db
    .insert(skills)
    .values(clean.map((name) => ({ userId, name, category: category || null })))
    .onConflictDoNothing()
    .returning();
  await bumpProfileVersion(db, userId);
  return rows;
}

export async function deleteSkill(db: Db, userId: string, id: string) {
  await db.delete(skills).where(and(eq(skills.id, id), eq(skills.userId, userId)));
  await bumpProfileVersion(db, userId);
}

// ── Verified career facts ──

export const careerFactSchema = z.object({
  category: z.enum(["achievement", "contract_value", "team_size", "savings", "package", "other"]),
  statement: z.string().trim().min(5).max(600),
  numericValue: z.coerce.number().nonnegative().nullish(),
  unit: z.string().trim().max(20).nullish(),
  meaning: z.string().trim().max(400).nullish(),
  workExperienceId: z.string().uuid().nullish(),
});

export async function listCareerFacts(db: Executor, userId: string, onlyVerified = false) {
  return db
    .select()
    .from(careerFacts)
    .where(and(eq(careerFacts.userId, userId), onlyVerified ? eq(careerFacts.status, "verified") : undefined))
    .orderBy(desc(careerFacts.createdAt));
}

/**
 * Facts typed by the user are saved as drafts; they only become usable by the
 * CV/letter engines after an explicit verify step that also confirms meaning
 * for numeric facts (e.g. "SAR 60M = single contract value I negotiated").
 */
export async function addCareerFact(db: Db, userId: string, input: unknown, source: "user" | "cv_extraction" = "user") {
  const v = parseOrThrow(careerFactSchema, input, "invalid_fact");
  if (v.workExperienceId) {
    const [own] = await db
      .select({ id: workExperiences.id })
      .from(workExperiences)
      .where(and(eq(workExperiences.id, v.workExperienceId), eq(workExperiences.userId, userId)));
    if (!own) throw notFound("Experience");
  }
  const [row] = await db
    .insert(careerFacts)
    .values({ ...v, numericValue: v.numericValue == null ? null : String(v.numericValue), userId, source, status: "draft" })
    .returning();
  return row!;
}

export async function verifyCareerFact(db: Db, userId: string, id: string, meaning?: string | null) {
  const [fact] = await db.select().from(careerFacts).where(and(eq(careerFacts.id, id), eq(careerFacts.userId, userId)));
  if (!fact) throw notFound("Fact");
  const finalMeaning = meaning?.trim() || fact.meaning;
  if (fact.numericValue !== null && !finalMeaning) {
    throw new AppError("meaning_required", "Explain what this number means (e.g. single contract value, cumulative total) before verifying.");
  }
  const [row] = await db
    .update(careerFacts)
    .set({ status: "verified", verifiedAt: new Date(), meaning: finalMeaning, updatedAt: new Date() })
    .where(and(eq(careerFacts.id, id), eq(careerFacts.userId, userId)))
    .returning();
  await bumpProfileVersion(db, userId);
  await audit(db, { userId, actor: "user", action: "fact.verified", entityType: "career_fact", entityId: id });
  return row!;
}

export async function rejectCareerFact(db: Db, userId: string, id: string) {
  await db
    .update(careerFacts)
    .set({ status: "rejected", verifiedAt: null, updatedAt: new Date() })
    .where(and(eq(careerFacts.id, id), eq(careerFacts.userId, userId)));
  await bumpProfileVersion(db, userId);
}

export async function deleteCareerFact(db: Db, userId: string, id: string) {
  await db.delete(careerFacts).where(and(eq(careerFacts.id, id), eq(careerFacts.userId, userId)));
  await bumpProfileVersion(db, userId);
}

/** Profile completeness used on Home and to gate automation. */
export async function profileCompleteness(db: Executor, userId: string) {
  const p = await getProfile(db, userId);
  const [exp, quals, sk] = await Promise.all([listExperiences(db, userId), listQualifications(db, userId), listSkills(db, userId)]);
  const checks = [
    { key: "name", label: "Full name", ok: !!p.fullName },
    { key: "contact", label: "Phone and contact email", ok: !!p.phone && !!p.contactEmail },
    { key: "nationality", label: "Nationality and residency", ok: !!p.nationality && !!p.residencyCountry },
    { key: "titles", label: "Target job titles", ok: p.preferredTitles.length > 0 },
    { key: "locations", label: "Preferred locations", ok: p.preferredLocations.length > 0 },
    { key: "experience", label: "Work experience", ok: exp.length > 0 },
    { key: "qualifications", label: "Qualifications", ok: quals.length > 0 },
    { key: "skills", label: "Skills", ok: sk.length >= 3 },
    { key: "notice", label: "Notice period", ok: p.noticePeriodDays !== null },
    { key: "salary", label: "Expected salary", ok: !!p.expectedSalary && !!p.salaryCurrency },
  ];
  const done = checks.filter((c) => c.ok).length;
  return { percent: Math.round((done / checks.length) * 100), checks };
}
