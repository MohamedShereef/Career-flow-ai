export interface NormalizedJob {
  externalId: string;
  title: string;
  companyName: string;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  employmentType: string | null;
  description: string | null;
  postedAt: Date | null;
  sourceUrl: string;
  applyUrl: string;
  atsKind: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  raw?: unknown;
}

export interface SourceConfig {
  kind: string;
  name: string;
  identifier: string;
  config: Record<string, unknown>;
}

export interface FetchContext {
  /** Search terms (from users' target titles) for sources that support keyword search. */
  queries: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Hard cap on postings fetched per source per run. */
  limit: number;
}

export type Adapter = (src: SourceConfig, ctx: FetchContext) => Promise<NormalizedJob[]>;
