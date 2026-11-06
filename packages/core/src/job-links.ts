/**
 * One place that decides what a job link is: the employer's own careers site / ATS,
 * or a job board that reposts jobs (robot checks, no employer form). Used by
 * discovery (which link to keep), the employer-site finder and the apply worker.
 */

/** Sites that repost jobs. Their pages rarely hold the employer's form; we follow their Apply link instead. */
const JOB_BOARD_HOSTS =
  /(^|\.)(indeed\.[a-z.]+|glassdoor\.[a-z.]+|bayt\.com|naukrigulf\.com|gulftalent\.com|recruit\.net|jooble\.org|talent\.com|jobrapido\.com|whatjobs\.com|adzuna\.[a-z.]+|careerjet\.[a-z.]+|jobsora\.com|simplyhired\.[a-z.]+|ziprecruiter\.[a-z.]+|monster\.[a-z.]+|drjobpro\.com|drjob\.[a-z.]+|akhtaboot\.com|wuzzuf\.net|tanqeeb\.com|laimoon\.com|expatriates\.com|dubizzle\.com|jobleads\.com|lensa\.com|learn4good\.com|jobtome\.com|jobted\.[a-z.]+|neuvoo\.[a-z.]+|jora\.com|mourjan\.com|founditgulf\.com|monstergulf\.com|naukri\.com|shine\.com|xpatjobs\.[a-z.]+|ksa-jobs\.com|saudijobs\.[a-z.]+|jobzmall\.com|ladders\.com|dice\.com|google\.com|bebee\.com|mihnati\.com|jobsora\.com|trabajo\.org|jobisjob\.[a-z.]+|joblist\.com|snagajob\.com|workcircle\.com|jobilize\.com|salary\.com|glints\.com|careerbuilder\.com|jobsinsaudi\.[a-z.]+|gulfjobs\.[a-z.]+|jobslin\.com|jobsearchsaudi\.[a-z.]+|recruitmentsaudi\.[a-z.]+|recruiter\.com|jobtoday\.com|adzuna\.[a-z.]+|jobberman\.com|hirect\.in|apna\.co|wellfound\.com|builtin\.com|jooble\.[a-z.]+|kitjob\.[a-z.]+|jobsdb\.com|jobstreet\.[a-z.]+|seek\.com\.au|reed\.co\.uk|totaljobs\.com|cv-library\.co\.uk|stepstone\.[a-z.]+|xing\.com|infojobs\.[a-z.]+|computrabajo\.[a-z.]+|olx\.[a-z.]+|opensooq\.com|haraj\.com\.sa)$/;

export function isJobBoardUrl(url: string) {
  const k = atsFromUrl(url);
  return k === "job_board" || k === "linkedin";
}

/**
 * A "career site" link whose address doesn't mention the employer is probably a job board we
 * don't know yet (bebee, …): look for the employer's own posting before trusting it.
 */
export function probablyNotEmployerSite(url: string, companyName: string) {
  if (isJobBoardUrl(url)) return true;
  if (atsFromUrl(url) !== "career_site") return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  const words = companyName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length >= 4 && !["company", "group", "arabia", "saudi", "international", "contracting", "investment", "holding", "limited", "trading"].includes(w));
  return words.length > 0 && !words.some((w) => host.includes(w)) && !host.includes(words.join(""));
}

/** Best guess of the application system from the link. */
export function atsFromUrl(url: string): string {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (/greenhouse\.io$/.test(h)) return "greenhouse";
  if (/lever\.co$/.test(h)) return "lever";
  if (/ashbyhq\.com$/.test(h)) return "ashby";
  if (/workable\.com$/.test(h)) return "workable";
  if (/smartrecruiters\.com$/.test(h)) return "smartrecruiters";
  if (/myworkdayjobs\.com$|workday\.com$/.test(h)) return "workday";
  if (/successfactors\.|jobs2web\.com$|sapsf\./.test(h)) return "successfactors";
  if (/taleo\.net$|oraclecloud\.com$/.test(h)) return "oracle";
  if (/(^|\.)linkedin\.com$/.test(h)) return "linkedin";
  if (JOB_BOARD_HOSTS.test(h)) return "job_board";
  return "career_site";
}

export const ATS_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|successfactors\.(com|eu)|sapsf\.(com|eu)|jobs2web\.com|taleo\.net|oraclecloud\.com|icims\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|jobvite\.com|breezy\.hr|zohorecruit\.[a-z.]+|personio\.(de|com)|pinpointhq\.com|rippling\.com|eightfold\.ai|phenompeople\.com)$/i;
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


/** True when the link is the employer's own careers site or their application system. */
export function onEmployerSite(url: string, company: string) {
  if (!url || atsFromUrl(url) === "unknown") return false;
  if (probablyNotEmployerSite(url, company)) return false;
  // A shared ATS is the employer's own system; a plain site must name the company.
  return atsFromUrl(url) !== "career_site" || looksLikeEmployerPosting(url, "", company);
}

/**
 * From the links a search engine lists for one job, keep the employer's own posting.
 * Order: a link that names the employer (or its ATS), a link marked direct that isn't a
 * job board, any non-board link, and only then a job board.
 */
export function pickApplyLink(options: Array<{ url: string; direct?: boolean }>, title: string, company: string, fallback = "") {
  const links = options.filter((o) => o.url);
  const employer = links.find((o) => looksLikeEmployerPosting(o.url, title, company)) ?? links.find((o) => onEmployerSite(o.url, company));
  if (employer) return { url: employer.url, employerSite: true };
  const direct = links.find((o) => o.direct && !isJobBoardUrl(o.url));
  const other = direct ?? links.find((o) => !isJobBoardUrl(o.url) && !probablyNotEmployerSite(o.url, company));
  if (other) return { url: other.url, employerSite: onEmployerSite(other.url, company) };
  return { url: links[0]?.url ?? fallback, employerSite: false };
}

export type CareerSource = { kind: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "workday" | "successfactors" | "oracle"; identifier: string };

/**
 * The employer's careers site behind a posting link, in the form a job source needs,
 * so that employer's next jobs come straight from its own site. Null when the link
 * isn't on a system CareerFlow can read directly.
 */
export function careerSourceFromUrl(url: string): CareerSource | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  const first = seg[0] ?? "";
  const ok = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{1,80}$/.test(s);
  if (/^(boards|job-boards)\.greenhouse\.io$/.test(h)) {
    const token = first === "embed" ? u.searchParams.get("for") ?? "" : first;
    return ok(token) ? { kind: "greenhouse", identifier: token } : null;
  }
  if (h === "jobs.lever.co") return ok(first) ? { kind: "lever", identifier: first } : null;
  if (h === "jobs.ashbyhq.com") return ok(first) ? { kind: "ashby", identifier: first } : null;
  if (h === "jobs.smartrecruiters.com" || h === "careers.smartrecruiters.com") return ok(first) ? { kind: "smartrecruiters", identifier: first } : null;
  if (h === "apply.workable.com") return ok(first) && first !== "api" ? { kind: "workable", identifier: first } : null;
  if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(h)) {
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(first) ? seg[1] : first;
    return site && ok(site) && site !== "job" ? { kind: "workday", identifier: `https://${h}/${site}` } : null;
  }
  if (/\.jobs2web\.com$/.test(h)) return { kind: "successfactors", identifier: `https://${h}` };
  // Oracle Recruiting Cloud: …/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>
  const ora = u.pathname.match(/^\/hcmUI\/CandidateExperience\/([a-z]{2}(?:-[A-Z]{2})?)\/sites\/([A-Za-z0-9_-]+)/);
  if (ora && /oraclecloud\.com$/.test(h)) return { kind: "oracle", identifier: `https://${h}/hcmUI/CandidateExperience/en/sites/${ora[2]}` };
  // SAP SuccessFactors career sites on the employer's own domain: /job/<title-slug>/<number>/
  if (/^\/job\/[^/]+\/\d{6,}\/?$/.test(u.pathname) && !JOB_BOARD_HOSTS.test(h)) return { kind: "successfactors", identifier: `https://${h}` };
  return null;
}

/**
 * A job is on the employer's site when it came from an official careers-site source (whatever
 * the domain is called, e.g. careers.dgda.gov.sa for Diriyah), or when its link is one.
 */
export function jobOnEmployerSite(job: { applyUrl: string; companyName: string; raw?: unknown }) {
  return (job.raw as { official?: boolean } | null | undefined)?.official === true || onEmployerSite(job.applyUrl, job.companyName);
}
