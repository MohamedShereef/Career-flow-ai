/**
 * Job-source adapters. Each uses the employer's public, documented job-board
 * endpoint (the same data the employer's own careers page shows) and returns
 * normalized postings. No logins, no scraping of sites that forbid it.
 */
import { guessCountry, htmlToText, toDate } from "./text";
import type { Adapter, FetchContext, NormalizedJob, SourceConfig } from "./types";

const UA = "CareerFlowAI/1.0 (+job discovery for a single job seeker)";

async function getJson<T>(ctx: FetchContext, url: string, init: RequestInit = {}): Promise<T> {
  const res = await (ctx.fetchImpl ?? fetch)(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": UA, ...(init.headers ?? {}) },
    signal: ctx.signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ── Greenhouse: boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true ──
type GhJob = { id: number; title: string; absolute_url: string; updated_at?: string; first_published?: string; location?: { name?: string }; content?: string; offices?: Array<{ name?: string; location?: string }> };
export const greenhouse: Adapter = async (src, ctx) => {
  const data = await getJson<{ jobs: GhJob[] }>(ctx, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(src.identifier)}/jobs?content=true`);
  return (data.jobs ?? []).slice(0, ctx.limit).map((j) => {
    const loc = s(j.location?.name) ?? s(j.offices?.map((o) => o.location ?? o.name).filter(Boolean).join("; "));
    return {
      externalId: String(j.id),
      title: j.title,
      companyName: src.name,
      location: loc,
      country: guessCountry(loc),
      remoteType: /remote/i.test(loc ?? "") ? "remote" : null,
      employmentType: null,
      description: htmlToText(j.content),
      postedAt: toDate(j.first_published ?? j.updated_at),
      sourceUrl: j.absolute_url,
      applyUrl: j.absolute_url,
      atsKind: "greenhouse",
    };
  });
};

// ── Lever: api.lever.co/v0/postings/{company}?mode=json (EU: api.eu.lever.co) ──
type LvJob = { id: string; text: string; hostedUrl: string; applyUrl?: string; createdAt?: number; workplaceType?: string; country?: string; categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] }; descriptionPlain?: string; lists?: Array<{ text: string; content: string }>; additionalPlain?: string; salaryRange?: { min?: number; max?: number; currency?: string } };
export const lever: Adapter = async (src, ctx) => {
  const host = src.config.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
  const data = await getJson<LvJob[]>(ctx, `https://${host}/v0/postings/${encodeURIComponent(src.identifier)}?mode=json`);
  return (data ?? []).slice(0, ctx.limit).map((j) => {
    const loc = s(j.categories?.allLocations?.join("; ")) ?? s(j.categories?.location);
    const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content) ?? ""}`).join("\n\n");
    return {
      externalId: j.id,
      title: j.text,
      companyName: src.name,
      location: loc,
      country: guessCountry(loc, j.country),
      remoteType: s(j.workplaceType),
      employmentType: s(j.categories?.commitment),
      description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n") || null,
      postedAt: toDate(j.createdAt),
      sourceUrl: j.hostedUrl,
      applyUrl: j.applyUrl ?? `${j.hostedUrl}/apply`,
      atsKind: "lever",
      salaryMin: j.salaryRange?.min ?? null,
      salaryMax: j.salaryRange?.max ?? null,
      salaryCurrency: j.salaryRange?.currency ?? null,
    };
  });
};

// ── Ashby: api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true ──
type AbJob = { id: string; title: string; location?: string; secondaryLocations?: Array<{ location?: string }>; employmentType?: string; workplaceType?: string; isRemote?: boolean; jobUrl: string; applyUrl?: string; descriptionPlain?: string; descriptionHtml?: string; publishedAt?: string; address?: { postalAddress?: { addressCountry?: string; addressLocality?: string } } };
export const ashby: Adapter = async (src, ctx) => {
  const data = await getJson<{ jobs: AbJob[] }>(ctx, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(src.identifier)}?includeCompensation=true`);
  return (data.jobs ?? []).slice(0, ctx.limit).map((j) => {
    const loc = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join("; ") || null;
    return {
      externalId: j.id,
      title: j.title,
      companyName: src.name,
      location: loc,
      country: guessCountry(loc, j.address?.postalAddress?.addressCountry),
      remoteType: j.isRemote ? "remote" : s(j.workplaceType),
      employmentType: s(j.employmentType),
      description: s(j.descriptionPlain) ?? htmlToText(j.descriptionHtml),
      postedAt: toDate(j.publishedAt),
      sourceUrl: j.jobUrl,
      applyUrl: j.applyUrl ?? j.jobUrl,
      atsKind: "ashby",
    };
  });
};

// ── SmartRecruiters: api.smartrecruiters.com/v1/companies/{id}/postings (+ detail) ──
type SrList = { content: Array<{ id: string; name: string; releasedDate?: string; location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string }; typeOfEmployment?: { label?: string }; company?: { name?: string } }>; totalFound: number };
type SrDetail = { applyUrl?: string; postingUrl?: string; jobAd?: { sections?: Record<string, { title?: string; text?: string }> } };
export const smartrecruiters: Adapter = async (src, ctx) => {
  const id = encodeURIComponent(src.identifier);
  const out: NormalizedJob[] = [];
  const country = typeof src.config.country === "string" ? `&country=${encodeURIComponent(src.config.country)}` : "";
  for (let offset = 0; offset < ctx.limit; offset += 100) {
    const page = await getJson<SrList>(ctx, `https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=100&offset=${offset}${country}`);
    for (const p of page.content ?? []) {
      const loc = s(p.location?.fullLocation) ?? s([p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", "));
      out.push({
        externalId: p.id,
        title: p.name,
        companyName: s(p.company?.name) ?? src.name,
        location: loc,
        country: guessCountry(loc, p.location?.country),
        remoteType: p.location?.remote ? "remote" : null,
        employmentType: s(p.typeOfEmployment?.label),
        description: null, // fetched below only for relevant titles
        postedAt: toDate(p.releasedDate),
        sourceUrl: `https://jobs.smartrecruiters.com/${src.identifier}/${p.id}`,
        applyUrl: `https://jobs.smartrecruiters.com/${src.identifier}/${p.id}`,
        atsKind: "smartrecruiters",
      });
    }
    if ((page.content ?? []).length < 100 || out.length >= page.totalFound) break;
  }
  return out.slice(0, ctx.limit);
};
export async function smartrecruitersDetail(src: SourceConfig, job: NormalizedJob, ctx: FetchContext): Promise<NormalizedJob> {
  const d = await getJson<SrDetail>(ctx, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(src.identifier)}/postings/${encodeURIComponent(job.externalId)}`);
  const sections = Object.values(d.jobAd?.sections ?? {})
    .map((x) => [x.title, htmlToText(x.text)].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return { ...job, description: sections || null, applyUrl: d.applyUrl ?? job.applyUrl, sourceUrl: d.postingUrl ?? job.sourceUrl };
}

// ── Workable (single employer): apply.workable.com/api/v1/widget/accounts/{account}?details=true ──
type WkJob = { title: string; shortcode: string; url?: string; application_url?: string; shortlink?: string; country?: string; city?: string; state?: string; telecommuting?: boolean; employment_type?: string; description?: string; published_on?: string; created_at?: string; locations?: Array<{ country?: string; city?: string }> };
export const workable: Adapter = async (src, ctx) => {
  const data = await getJson<{ name?: string; jobs: WkJob[] }>(ctx, `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(src.identifier)}?details=true`);
  return (data.jobs ?? []).slice(0, ctx.limit).map((j) => {
    const loc = s([j.city, j.state, j.country].filter(Boolean).join(", ")) ?? s(j.locations?.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join("; "));
    const url = j.url ?? j.shortlink ?? `https://apply.workable.com/${src.identifier}/j/${j.shortcode}/`;
    return {
      externalId: j.shortcode,
      title: j.title,
      companyName: s(data.name) ?? src.name,
      location: loc,
      country: guessCountry(loc),
      remoteType: j.telecommuting ? "remote" : null,
      employmentType: s(j.employment_type),
      description: htmlToText(j.description),
      postedAt: toDate(j.published_on ?? j.created_at),
      sourceUrl: url,
      applyUrl: j.application_url ?? url,
      atsKind: "workable",
    };
  });
};

// ── Workday (cxs JSON used by every Workday careers site) ──
// identifier = careers URL, e.g. https://kbr.wd5.myworkdayjobs.com/en-US/KBR_Careers
type WdList = { total: number; jobPostings: Array<{ title: string; externalPath: string; locationsText?: string; postedOn?: string; bulletFields?: string[] }> };
type WdDetail = { jobPostingInfo?: { id?: string; title?: string; jobDescription?: string; location?: string; additionalLocations?: string[]; country?: { descriptor?: string }; startDate?: string; timeType?: string; externalUrl?: string; jobReqId?: string; remoteType?: string } };
export function parseWorkdayUrl(u: string) {
  const url = new URL(u);
  const tenant = url.hostname.split(".")[0]!;
  const parts = url.pathname.split("/").filter(Boolean).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
  const site = parts[0];
  if (!url.hostname.endsWith("myworkdayjobs.com") || !site) throw new Error("Use the Workday careers URL, like https://company.wd3.myworkdayjobs.com/en-US/SiteName");
  return { host: url.hostname, tenant, site, base: `https://${url.hostname}/wday/cxs/${tenant}/${site}` };
}
export const workday: Adapter = async (src, ctx) => {
  const { base } = parseWorkdayUrl(src.identifier);
  const careersUrl = new URL(src.identifier);
  const careersBase = `${careersUrl.origin}${careersUrl.pathname.replace(/\/$/, "")}`;
  const queries = ctx.queries.length ? ctx.queries : ["procurement"];
  const seen = new Map<string, NormalizedJob>();
  for (const q of queries.slice(0, 6)) {
    for (let offset = 0; offset < Math.min(ctx.limit, 100); offset += 20) {
      const page = await getJson<WdList>(ctx, `${base}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }),
      });
      for (const p of page.jobPostings ?? []) {
        if (seen.has(p.externalPath)) continue;
        seen.set(p.externalPath, {
          externalId: p.externalPath,
          title: p.title,
          companyName: src.name,
          location: s(p.locationsText),
          country: guessCountry(p.locationsText),
          remoteType: null,
          employmentType: null,
          description: null, // fetched in detail for relevant titles
          postedAt: null,
          sourceUrl: `${careersBase}${p.externalPath}`,
          applyUrl: `${careersBase}${p.externalPath}/apply`,
          atsKind: "workday",
        });
      }
      if ((page.jobPostings ?? []).length < 20) break;
    }
  }
  return [...seen.values()].slice(0, ctx.limit);
};
export async function workdayDetail(src: SourceConfig, job: NormalizedJob, ctx: FetchContext): Promise<NormalizedJob> {
  const { base } = parseWorkdayUrl(src.identifier);
  const d = await getJson<WdDetail>(ctx, `${base}${job.externalId}`);
  const i = d.jobPostingInfo ?? {};
  const loc = [i.location, ...(i.additionalLocations ?? [])].filter(Boolean).join("; ") || job.location;
  return {
    ...job,
    description: htmlToText(i.jobDescription),
    location: loc,
    country: guessCountry(loc, i.country?.descriptor) ?? job.country,
    employmentType: s(i.timeType),
    remoteType: s(i.remoteType),
    postedAt: toDate(i.startDate),
    sourceUrl: i.externalUrl ?? job.sourceUrl,
    applyUrl: i.externalUrl ? `${i.externalUrl.replace(/\/$/, "")}/apply` : job.applyUrl,
  };
}

export const ADAPTERS: Record<string, Adapter> = { greenhouse, lever, ashby, smartrecruiters, workable, workday };

/** Second pass for list-only APIs: fetch the full description. */
export const DETAIL: Record<string, (src: SourceConfig, job: NormalizedJob, ctx: FetchContext) => Promise<NormalizedJob>> = {
  smartrecruiters: smartrecruitersDetail,
  workday: workdayDetail,
};

export const SOURCE_HELP: Record<string, { label: string; identifier: string; example: string }> = {
  workday: { label: "Workday careers site", identifier: "Careers page URL", example: "https://kbr.wd5.myworkdayjobs.com/en-US/KBR_Careers" },
  smartrecruiters: { label: "SmartRecruiters", identifier: "Company id (from jobs.smartrecruiters.com/<id>)", example: "AECOM2" },
  workable: { label: "Workable", identifier: "Account (from apply.workable.com/<account>)", example: "qiddiya" },
  greenhouse: { label: "Greenhouse", identifier: "Board token (from boards.greenhouse.io/<token>)", example: "acme" },
  lever: { label: "Lever", identifier: "Company (from jobs.lever.co/<company>)", example: "acme" },
  ashby: { label: "Ashby", identifier: "Board name (from jobs.ashbyhq.com/<name>)", example: "acme" },
};

// ── SAP SuccessFactors Career Site Builder (RSS feed every CSB site exposes) ──
// identifier = careers site origin, e.g. https://neom.jobs2web.com
function rssItems(xml: string) {
  const items: Array<{ title: string; link: string; description: string | null; pubDate: string | null }> = [];
  const tag = (block: string, name: string) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? m[1]!.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() : null;
  };
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = tag(b, "title");
    const link = tag(b, "link");
    if (title && link) items.push({ title: htmlToText(title) ?? title, link, description: tag(b, "description"), pubDate: tag(b, "pubDate") });
  }
  return items;
}
export const successfactors: Adapter = async (src, ctx) => {
  const origin = new URL(src.identifier).origin;
  const queries = ctx.queries.length ? ctx.queries : ["procurement"];
  const seen = new Map<string, NormalizedJob>();
  for (const q of queries.slice(0, 6)) {
    const res = await (ctx.fetchImpl ?? fetch)(`${origin}/services/rss/job/?locale=en_US&keywords=${encodeURIComponent(`(${q})`)}`, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" },
      signal: ctx.signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${new URL(origin).host} responded ${res.status}`);
    for (const it of rssItems(await res.text())) {
      const id = it.link.match(/\/(\d{5,})\/?(?:\?|$)/)?.[1] ?? it.link;
      if (seen.has(id)) continue;
      // CSB titles are usually "Job Title (City, Country)" or "Job Title - City".
      const locMatch = it.title.match(/\(([^()]+)\)\s*$/);
      const desc = htmlToText(it.description);
      seen.set(id, {
        externalId: id,
        title: locMatch ? it.title.slice(0, locMatch.index).trim() : it.title,
        companyName: src.name,
        location: locMatch?.[1] ?? null,
        country: guessCountry(locMatch?.[1], desc?.slice(0, 400)),
        remoteType: null,
        employmentType: null,
        description: desc && desc.length > 400 ? desc : null,
        postedAt: toDate(it.pubDate),
        sourceUrl: it.link,
        applyUrl: it.link,
        atsKind: "successfactors",
      });
    }
  }
  return [...seen.values()].slice(0, ctx.limit);
};
export async function successfactorsDetail(_src: SourceConfig, job: NormalizedJob, ctx: FetchContext): Promise<NormalizedJob> {
  if (job.description) return job;
  const res = await (ctx.fetchImpl ?? fetch)(job.sourceUrl, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctx.signal ?? AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`job page responded ${res.status}`);
  const html = await res.text();
  const block = html.match(/<span[^>]+class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i)?.[1] ?? html.match(/<div[^>]+class="[^"]*job(?:-|)description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const text = htmlToText(block ?? html.replace(/[\s\S]*<body[^>]*>/i, ""));
  return { ...job, description: text ? text.slice(0, 20_000) : null };
}
ADAPTERS.successfactors = successfactors;
DETAIL.successfactors = successfactorsDetail;
SOURCE_HELP.successfactors = { label: "SAP SuccessFactors careers site", identifier: "Careers site address", example: "https://neom.jobs2web.com" };
