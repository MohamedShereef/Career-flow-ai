/**
 * Server-side admin commands (run on the server, never exposed over HTTP).
 *   npm run admin -- reset-password <email>   → prints a one-time reset link
 */
import { auth } from "@careerflow/core";
import { createDb } from "@careerflow/db";

const [cmd, arg] = process.argv.slice(2);
const { db, pool } = createDb(process.env.DATABASE_URL, { max: 1 });

try {
  if (cmd === "reset-password" && arg) {
    const r = await auth.requestPasswordReset(db, arg, { ip: "admin-cli" });
    if (!r) {
      console.log("No account with that email.");
    } else {
      const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
      console.log(`One-time reset link (valid 60 minutes):\n${base}/reset-password?token=${encodeURIComponent(r.token)}`);
    }
  } else {
    console.log("Usage: npm run admin -- reset-password <email>");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
