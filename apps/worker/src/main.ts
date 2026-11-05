import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { createDb } from "@careerflow/db";
import { applyHandlers } from "./apply/handlers";
import { handlers as baseHandlers } from "./handlers";
import { log } from "./log";
import { Runner } from "./runner";

for (const name of ["DATABASE_URL", "APP_ENCRYPTION_KEY"]) {
  if (!process.env[name]) {
    log("error", `missing required env ${name}`);
    process.exit(1);
  }
}

const { db, pool } = createDb(process.env.DATABASE_URL, { max: Number(process.env.DB_POOL_MAX ?? 5) });
const handlers = { ...baseHandlers, ...applyHandlers };
const runner = new Runner({ db, handlers, kind: process.env.WORKER_KIND ?? "general", version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) });

const server = createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  try {
    await db.execute(sql`select 1`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...runner.health() }));
  } catch {
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
  }
});
server.listen(Number(process.env.PORT ?? 8080), () => log("info", "worker.started", { workerId: runner.workerId, port: process.env.PORT ?? 8080 }));

void runner.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "worker.stopping", { signal });
  server.close();
  await runner.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
