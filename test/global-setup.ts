import pg from "pg";
import { runMigrations } from "../packages/db/src/migrate";

/** Rebuilds the test database from migrations — this doubles as the migration test. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/careerflow_test";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  await runMigrations(url);
  await runMigrations(url); // re-running must be a no-op
}
