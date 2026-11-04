import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../packages/db/src";
import * as auth from "../packages/core/src/services/auth";

let handle: DbHandle | null = null;

export function testDb() {
  handle ??= createDb(process.env.TEST_DATABASE_URL, { max: 10 });
  return handle.db;
}

export async function closeDb() {
  await handle?.pool.end();
  handle = null;
}

export async function makeUser(prefix = "user") {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await auth.signUp(testDb(), { email, password: "correct horse 42", displayName: "Test User" }, { ip: randomUUID() });
  return { ...res, email, password: "correct horse 42" };
}

export async function truncateQueue() {
  await testDb().execute(sql`TRUNCATE tasks`);
}
