import { autoapply } from "@careerflow/core";
import { Badge } from "@/components/ui";

/** Where applying would happen: the employer's own site, or only a job board. */
export function LinkBadge({ url, company, raw, checked }: { url: string; company: string; raw?: unknown; checked?: boolean }) {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  if (autoapply.jobOnEmployerSite({ applyUrl: url, companyName: company, raw })) return <Badge tone="good">Employer's site{host ? ` · ${host}` : ""}</Badge>;
  return <Badge tone="attention">{checked ? "Only on job boards" : "Job board — looking for the employer's site"}{host ? ` · ${host}` : ""}</Badge>;
}

/** True once CareerFlow searched this week for the job on the employer's own site. */
export function employerSiteChecked(raw: unknown) {
  return !!(raw as { employerLink?: { at?: string } } | null)?.employerLink?.at;
}
