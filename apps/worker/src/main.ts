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
const version = process.env.APP_VERSION ?? process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
// Browser work (preparing and submitting applications) takes minutes per task, so it gets its own
// lane: tailoring, matching, discovery and email keep running while an application is being filled.
const { "application.prepare": prep, "application.submit": sub, "application.resume": res0, ...quickApply } = applyHandlers;
const browserHandlers = { "application.prepare": prep!, "application.submit": sub!, "application.resume": res0! };
const generalHandlers = { ...baseHandlers, ...quickApply };
const runners = [
  new Runner({ db, handlers: generalHandlers, kind: "general", version }),
  new Runner({ db, handlers: browserHandlers, kind: "browser", version }),
];
const runner = {
  health: () => ({ runners: runners.map((r) => r.health()) }),
  workerId: runners.map((r) => r.workerId).join(","),
};

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

for (const r of runners) void r.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "worker.stopping", { signal });
  server.close();
  await Promise.all(runners.map((r) => r.stop()));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
