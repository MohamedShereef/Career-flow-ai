/**
 * Job boards that repost jobs (recruit.net, Jooble, …) often show robot checks
 * and rarely host the employer's form. Instead of fighting them, find the same
 * job on the employer's own careers site or ATS and apply there.
 *
 * 1. Other links Google already returned for this job (free).
 * 2. One web search via SerpApi (cached on the job for 7 days).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { jobEvaluations, jobSources, jobs } from "@careerflow/db";
import type { Db } from "../types";
import { atsFromUrl, careerSourceFromUrl, jobOnEmployerSite, looksLikeEmployerPosting } from "../job-links";
import { audit } from "./audit";
export { looksLikeEmployerPosting } from "../job-links";

type SearchFn = (q: string) => Promise<Array<{ link: string; title: string }>>;

const serpSearch: SearchFn = async (q) => {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  const res = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=10&hl=en&api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return [];
  const d = (await res.json()) as { organic_results?: Array<{ link?: string; title?: string }> };
  return (d.organic_results ?? []).filter((r) => r.link).map((r) => ({ link: r.link!, title: r.title ?? "" }));
};

export async function findEmployerLink(db: Db, job: typeof jobs.$inferSelect, opts: { search?: SearchFn } = {}): Promise<{ url: string; via: "listing" | "search" } | null> {
  const raw = (job.raw ?? {}) as { applyOptions?: string[]; employerLink?: { url: string | null; at: string } };

  for (const u of raw.applyOptions ?? []) {
    if (looksLikeEmployerPosting(u, job.title, job.companyName)) return { url: u, via: "listing" };
  }

  if (raw.employerLink && Date.now() - Date.parse(raw.employerLink.at) < 7 * 86_400_000) {
    return raw.employerLink.url ? { url: raw.employerLink.url, via: "search" } : null;
  }
  const search = opts.search ?? (process.env.SERPAPI_KEY ? serpSearch : null);
  if (!search) return null;

  const results = await search(`"${job.title}" ${job.companyName} careers apply`).catch(() => []);
  const hit = results.find((r) => looksLikeEmployerPosting(r.link, job.title, job.companyName, r.title));
  const url = hit?.link ?? null;
  await db
    .update(jobs)
    .set({ raw: { ...raw, employerLink: { url, at: new Date().toISOString() } } })
    .where(eq(jobs.id, job.id));
  return url ? { url, via: "search" } : null;
}


/**
 * Watch the employer's own careers site from now on, so its next jobs come straight
 * from the source. Returns the new source, or null when it's already watched or the
 * site isn't one CareerFlow can read directly.
 */
export async function adoptCareerSource(db: Db, url: string, companyName: string) {
  const cs = careerSourceFromUrl(url);
  if (!cs) return null;
  const [row] = await db
    .insert(jobSources)
    .values({ kind: cs.kind, name: companyName.slice(0, 120), identifier: cs.identifier, config: { autoAdded: true, foundFrom: url.slice(0, 500) } })
    .onConflictDoNothing()
    .returning();
  if (row) await audit(db, { userId: null, actor: "agent", action: "source.auto_added", entityType: "job_source", entityId: row.id, metadata: { kind: cs.kind, company: companyName } });
  return row ?? null;
}

export type SiteResult = { jobId: string; status: "already_employer" | "found" | "not_found"; url?: string; newSourceId?: string };

/**
 * Make a job point at the employer's own posting. Jobs already there only teach us the
 * employer's careers site; the others get one cached search.
 */
export async function resolveEmployerSite(db: Db, jobId: string, opts: { search?: SearchFn } = {}): Promise<SiteResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { jobId, status: "not_found" };
  if (jobOnEmployerSite(job)) {
    const src = await adoptCareerSource(db, job.applyUrl, job.companyName);
    return { jobId, status: "already_employer", url: job.applyUrl, newSourceId: src?.id };
  }
  const found = await findEmployerLink(db, job, opts);
  if (!found) return { jobId, status: "not_found" };
  const raw = ((await db.select({ raw: jobs.raw }).from(jobs).where(eq(jobs.id, jobId)))[0]?.raw ?? {}) as Record<string, unknown>;
  await db
    .update(jobs)
    .set({ applyUrl: found.url, atsKind: atsFromUrl(found.url), raw: { ...raw, boardUrl: job.applyUrl, official: true } })
    .where(eq(jobs.id, jobId));
  const src = await adoptCareerSource(db, found.url, job.companyName);
  return { jobId, status: "found", url: found.url, newSourceId: src?.id };
}

/** Jobs recommended to this user that still point at a job board and weren't searched this week. */
export async function jobsNeedingEmployerSite(db: Db, userId: string, limit = 10) {
  const rows = await db
    .select({ id: jobs.id, applyUrl: jobs.applyUrl, companyName: jobs.companyName, raw: jobs.raw })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(and(eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt), eq(jobEvaluations.decision, "recommended"), eq(jobs.status, "active")))
    .orderBy(sql`${jobEvaluations.score} desc`)
    .limit(200);
  const fresh = (raw: unknown) => {
    const at = (raw as { employerLink?: { at?: string } } | null)?.employerLink?.at;
    return !!at && Date.now() - Date.parse(at) < 7 * 86_400_000;
  };
  return rows.filter((r) => !jobOnEmployerSite(r) && !fresh(r.raw)).slice(0, limit).map((r) => r.id);
}

/** Recommended jobs whose employer careers site isn't watched yet (free: no search needed). */
export async function jobsOnUnwatchedEmployerSites(db: Db, userId: string, limit = 25) {
  const rows = await db
    .select({ id: jobs.id, applyUrl: jobs.applyUrl, company: jobs.companyName })
    .from(jobEvaluations)
    .innerJoin(jobs, eq(jobs.id, jobEvaluations.jobId))
    .where(and(eq(jobEvaluations.userId, userId), isNull(jobEvaluations.supersededAt), eq(jobEvaluations.decision, "recommended"), eq(jobs.status, "active")))
    .limit(300);
  const watched = new Set((await db.select({ kind: jobSources.kind, id: jobSources.identifier }).from(jobSources)).map((r) => `${r.kind}|${r.id.toLowerCase()}`));
  return rows
    .filter((r) => {
      const cs = careerSourceFromUrl(r.applyUrl);
      return cs && !watched.has(`${cs.kind}|${cs.identifier.toLowerCase()}`);
    })
    .slice(0, limit)
    .map((r) => r.id);
}
