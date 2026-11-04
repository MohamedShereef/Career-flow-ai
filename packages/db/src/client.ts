import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
}

/**
 * Creates a pooled connection. Works with Neon's standard (pooled) connection
 * string over TCP from both Vercel (Node runtime) and Railway.
 */
export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}): DbHandle {
  if (!url) throw new Error("DATABASE_URL is not set");
  const needsSsl = /sslmode=require|neon\.tech/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
  });
  return { db: drizzle(pool, { schema }), pool };
}

const globalForDb = globalThis as unknown as { __careerflowDb?: DbHandle };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getDb(): Database {
  if (!globalForDb.__careerflowDb) globalForDb.__careerflowDb = createDb();
  return globalForDb.__careerflowDb.db;
}
