import type { Database } from "@careerflow/db";

export type Db = Database;
/** A database handle or an open transaction. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}
