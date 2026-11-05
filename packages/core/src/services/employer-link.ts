/**
 * Job boards that repost jobs (recruit.net, Jooble, …) often show robot checks
 * and rarely host the employer's form. Instead of fighting them, find the same
 * job on the employer's own careers site or ATS and apply there.
 *
 * 1. Other links Google already returned for this job (free).
 * 2. One web search via SerpApi (cached on the job for 7 days).
 */
import { eq } from "drizzle-orm";
import { jobs } from "@careerflow/db";
import type { Db } from "../types";
import { isJobBoardUrl } from "./autoapply";

const ATS_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|jobs2web\.com|taleo\.net|oraclecloud\.com|icims\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|jobvite\.com|breezy\.hr|zohorecruit\.[a-z.]+|personio\.(de|com)|pinpointhq\.com|rippling\.com|eightfold\.ai|phenompeople\.com)$/i;

const STOP = new Set(["the", "and", "for", "of", "in", "at", "a", "an", "to", "with", "ksa", "saudi", "arabia", "riyadh", "jeddah", "dammam", "uae", "dubai", "llc", "ltd", "company", "co", "group", "limited", "jobs", "job"]);
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w));

function hostOf(u: string) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Is this link plausibly the employer's own posting for this job? */
export function looksLikeEmployerPosting(url: string, title: string, company: string, pageTitle = "") {
  if (!url || isJobBoardUrl(url)) return false;
  const host = hostOf(url);
  if (!host) return false;
  const co = words(company).filter((w) => w.length >= 4);
  const hay = `${host} ${url.toLowerCase()}`;
  const inLink = co.some((w) => hay.includes(w)) || (co.length > 1 && hay.includes(co.join("")));
  const inTitle = co.some((w) => pageTitle.toLowerCase().includes(w));
  const onAts = ATS_HOSTS.test(host);
  // Company's own domain must name the company; a shared ATS may use a short tenant name, so the result title can confirm it.
  if (!(inLink || (onAts && inTitle))) return false;
  if (!pageTitle) return true;
  const want = words(title);
  const got = new Set(words(pageTitle));
  const overlap = want.filter((w) => got.has(w)).length / Math.max(1, want.length);
  return overlap >= (onAts ? 0.5 : 0.6);
}

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

