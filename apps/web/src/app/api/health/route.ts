import { NextResponse } from "next/server";
import { dashboard } from "@careerflow/core";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Public liveness check: no user data, only component status. */
export async function GET() {
  try {
    const h = await dashboard.systemHealth(db());
    return NextResponse.json({
      ok: true,
      database: h.database,
      workerOnline: h.workerOnline,
      queue: h.queue,
      aiConfigured: h.ai.configured,
      version: process.env.APP_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    });
  } catch {
    return NextResponse.json({ ok: false, database: { ok: false } }, { status: 503 });
  }
}
