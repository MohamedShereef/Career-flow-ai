/**
 * Discovery Agent: pulls postings from configured employer job boards, keeps
 * only procurement-family roles, de-duplicates them, refreshes existing ones
 * and closes postings that disappeared. Source health is tracked per run.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { applicantProfiles, discoveryRuns, jobSources, jobs } from "@careerflow/db";
import { z } from "zod";
import { sha256 } from "../crypto";
import { ADAPTERS, DETAIL, SOURCE_HELP } from "../discovery/adapters";
import { guessCountry } from "../discovery/text";
import type { FetchContext, NormalizedJob, SourceConfig } from "../discovery/types";
import { AppError, notFound } from "../errors";
import { employerKey } from "../normalize";
import type { Db } from "../types";
import { audit } from "./audit";

// ── Relevance prefilter (cheap, deterministic; AI judges the rest) ──

const FAMILY = /\b(procure\w*|purchas\w*|buyer|sourcing|supply[\s-]?chain|materials?\s+(manager|engineer|controller|coordinator|lead|specialist)|contracts?\b|commercial|category\s+(manager|lead|specialist)|vendor|supplier|expedit\w*|tender\w*|subcontract\w*|logistics\s+manager)/i;
const NOT_FAMILY = /\b(quantity\s+surveyor|\bqs\b|talent|recruit\w*|human\s+resources|\bhr\b|payroll|software|developer|nurse|physician|chef|cook|sales\s+(executive|representative|associate)|marketing|cashier|driver|teacher|receptionist)\b/i;

export function isProcurementFamily(title: string): boolean {
  if (/procure|purchas|sourcing|supply\s*chain/i.test(title)) return true;
  return FAMILY.test(title) && !NOT_FAMILY.test(title);
}

export const DEFAULT_QUERIES = ["procurement", "purchasing", "supply chain", "contracts"];

// ── Sources ──

export const sourceInputSchema = z.object({
  kind: z.enum(["workday", "smartrecruiters", "workable", "greenhouse", "lever", "ashby", "successfactors"]),
  name: z.string().trim().min(2).max(120),
  identifier: z.string().trim().min(2).max(300),
});

/** Known public job boards, added on first start. Each is checked on the first run; failing ones show in Settings → Job sources. */
export const SEED_SOURCES: Array<z.infer<typeof sourceInputSchema>> = [
  { kind: "successfactors", name: "NEOM", identifier: "https://neom.jobs2web.com" },
  { kind: "smartrecruiters", name: "AECOM", identifier: "AECOM2" },
  { kind: "workday", name: "KBR", identifier: "https://kbr.wd5.myworkdayjobs.com/KBR_Careers" },
  { kind: "workable", name: "Qiddiya Investment Company", identifier: "qiddiya" },
];

export async function ensureSeedSources(db: Db) {
  if (process.env.SEED_SOURCES === "off") return;
  for (const s of SEED_SOURCES) {
    await db.insert(jobSources).values({ ...s, config: {} }).onConflictDoNothing();
  }
}

export async function addSource(db: Db, userId: string, input: unknown) {
  const r = sourceInputSchema.safeParse(input);
  if (!r.success) throw new AppError("invalid_source", r.error.issues[0]?.message ?? "Invalid source.");
  const v = r.data;
  if (v.kind === "workday" || v.kind === "successfactors") {
    try {
      new URL(v.identifier);
    } catch {
      throw new AppError("invalid_source", `Paste the full careers page address, e.g. ${SOURCE_HELP[v.kind]!.example}`);
    }
  }
  const [row] = await db.insert(jobSources).values({ ...v, config: {}, addedByUserId: userId }).onConflictDoNothing().returning();
  if (!row) throw new AppError("duplicate_source", "That job board is already being watched.");
  await audit(db, { userId, actor: "user", action: "source.added", entityType: "job_source", entityId: row.id, metadata: { kind: v.kind } });
  return row;
}

export async function setSourceEnabled(db: Db, userId: string, id: string, enabled: boolean) {
  await db.update(jobSources).set({ enabled, health: enabled ? "unknown" : "disabled" }).where(eq(jobSources.id, id));
  await audit(db, { userId, actor: "user", action: enabled ? "source.enabled" : "source.disabled", entityType: "job_source", entityId: id });
}

export async function listSources(db: Db) {
  return db
    .select({
      source: jobSources,
      activeJobs: sql<number>`(select count(*)::int from jobs j where j.source_id = ${jobSources.id} and j.status = 'active')`,
    })
    .from(jobSources)
    .orderBy(jobSources.name);
}

/** Search terms for keyword-based boards: users' target titles plus procurement defaults. */
async function searchQueries(db: Db): Promise<string[]> {
  const rows = await db.select({ t: applicantProfiles.preferredTitles }).from(applicantProfiles);
  const titles = rows.flatMap((r) => r.t).map((t) => t.toLowerCase().trim()).filter(Boolean);
  return [...new Set([...titles, ...DEFAULT_QUERIES])].slice(0, 8);
}

const toSourceConfig = (s: typeof jobSources.$inferSelect): SourceConfig => ({ kind: s.kind, name: s.name, identifier: s.identifier, config: s.config ?? {} });

function dedupeKeyFor(j: NormalizedJob) {
  let applyPath = j.applyUrl;
  try {
    const u = new URL(j.applyUrl);
    applyPath = `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    /* keep raw */
  }
  return sha256([employerKey(j.companyName), j.title.toLowerCase().replace(/\s+/g, " ").trim(), (j.location ?? "").toLowerCase(), applyPath].join("|"));
}

export interface RunResult {
  seen: number;
  relevant: number;
  new: number;
  updated: number;
  closed: number;
  detailErrors: number;
}

/** Fetch without saving — used by the "Test" button. */
export async function testSource(db: Db, input: unknown) {
  const r = sourceInputSchema.safeParse(input);
  if (!r.success) throw new AppError("invalid_source", r.error.issues[0]?.message ?? "Invalid source.");
  const adapter = ADAPTERS[r.data.kind]!;
  const ctx: FetchContext = { queries: await searchQueries(db), limit: 300 };
  try {
    const found = await adapter({ ...r.data, config: {} }, ctx);
    const relevant = found.filter((j) => isProcurementFamily(j.title));
    return { total: found.length, relevant: relevant.length, sample: relevant.slice(0, 5).map((j) => `${j.title} — ${j.location ?? "location n/a"}`) };
  } catch (err) {
    throw new AppError("source_failed", `Couldn't read that job board: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runSource(db: Db, sourceId: string, trigger: "scheduled" | "manual" | "reindex" = "scheduled", opts: { fetchImpl?: typeof fetch; detailLimit?: number } = {}): Promise<RunResult> {
  const [src] = await db.select().from(jobSources).where(eq(jobSources.id, sourceId));
  if (!src) throw notFound("Job source");
  const adapter = ADAPTERS[src.kind];
  if (!adapter) throw new AppError("unsupported_source", `No adapter for ${src.kind}.`);
  const [run] = await db.insert(discoveryRuns).values({ sourceId, trigger }).returning();
  const started = new Date();
  const result: RunResult = { seen: 0, relevant: 0, new: 0, updated: 0, closed: 0, detailErrors: 0 };
  const cfg = toSourceConfig(src);
  const ctx: FetchContext = { queries: await searchQueries(db), limit: 400, fetchImpl: opts.fetchImpl };

  try {
    const fetched = await adapter(cfg, ctx);
    result.seen = fetched.length;
    const relevant = fetched.filter((j) => isProcurementFamily(j.title));
    result.relevant = relevant.length;

    // Existing rows, so details are only fetched for new or changed postings.
    const existing = relevant.length
      ? await db
          .select({ id: jobs.id, externalId: jobs.externalId, description: jobs.description })
          .from(jobs)
          .where(and(eq(jobs.sourceId, sourceId), inArray(jobs.externalId, relevant.map((j) => j.externalId))))
      : [];
    const byExt = new Map(existing.map((e) => [e.externalId, e]));

    let details = 0;
    for (let job of relevant) {
      const prev = byExt.get(job.externalId);
      const detail = DETAIL[src.kind];
      if (detail && !job.description) {
        if (prev?.description) job = { ...job, description: prev.description };
        else if (details < (opts.detailLimit ?? 60)) {
          details++;
          try {
            job = await detail(cfg, job, ctx);
          } catch {
            result.detailErrors++;
          }
        }
      }
      const values = {
        sourceId,
        externalId: job.externalId,
        dedupeKey: dedupeKeyFor(job),
        title: job.title.slice(0, 300),
        companyName: job.companyName,
        employerKey: employerKey(job.companyName),
        location: job.location,
        country: job.country ?? guessCountry(job.location),
        remoteType: job.remoteType,
        employmentType: job.employmentType,
        description: job.description?.slice(0, 30_000) ?? null,
        descriptionHash: job.description ? sha256(job.description) : null,
        salaryMin: job.salaryMin == null ? null : String(job.salaryMin),
        salaryMax: job.salaryMax == null ? null : String(job.salaryMax),
        salaryCurrency: job.salaryCurrency ?? null,
        atsKind: job.atsKind,
        sourceUrl: job.sourceUrl,
        applyUrl: job.applyUrl,
        postedAt: job.postedAt,
        status: "active" as const,
        lastSeenAt: new Date(),
        closedAt: null,
      };
      if (prev) {
        await db.update(jobs).set(values).where(eq(jobs.id, prev.id));
        result.updated++;
      } else {
        const ins = await db.insert(jobs).values(values).onConflictDoNothing().returning({ id: jobs.id });
        if (ins.length) result.new++;
        else {
          // Same posting already known from another board: just mark it seen.
          await db.update(jobs).set({ lastSeenAt: new Date(), status: "active", closedAt: null }).where(eq(jobs.dedupeKey, values.dedupeKey));
          result.updated++;
        }
      }
    }

    // Close postings that vanished. Keyword-searched boards only close after a week unseen.
    const keywordBoard = src.kind === "workday" || src.kind === "successfactors";
    const cutoff = keywordBoard ? new Date(Date.now() - 7 * 86_400_000) : started;
    const closed = await db
      .update(jobs)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(eq(jobs.sourceId, sourceId), eq(jobs.status, "active"), lt(jobs.lastSeenAt, cutoff)))
      .returning({ id: jobs.id });
    result.closed = closed.length;

    await db
      .update(discoveryRuns)
      .set({ status: result.detailErrors ? "partial" : "succeeded", finishedAt: new Date(), jobsSeen: result.seen, jobsNew: result.new, jobsUpdated: result.updated, jobsClosed: result.closed })
      .where(eq(discoveryRuns.id, run!.id));
    await db
      .update(jobSources)
      .set({ health: result.detailErrors > result.relevant / 2 && result.relevant > 0 ? "degraded" : "healthy", consecutiveFailures: 0, lastSuccessAt: new Date(), lastError: null })
      .where(eq(jobSources.id, sourceId));
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.update(discoveryRuns).set({ status: "failed", finishedAt: new Date(), error: message }).where(eq(discoveryRuns.id, run!.id));
    await db
      .update(jobSources)
      .set({
        consecutiveFailures: sql`${jobSources.consecutiveFailures} + 1`,
        health: sql`CASE WHEN ${jobSources.consecutiveFailures} + 1 >= 3 THEN 'failing'::source_health ELSE 'degraded'::source_health END`,
        lastErrorAt: new Date(),
        lastError: message,
      })
      .where(eq(jobSources.id, sourceId));
    throw err;
  }
}

export async function enabledSourceIds(db: Db) {
  return (await db.select({ id: jobSources.id }).from(jobSources).where(eq(jobSources.enabled, true))).map((r) => r.id);
}
