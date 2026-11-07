import { NextResponse } from "next/server";
import { AppError, extension } from "@careerflow/core";
import { db } from "@/lib/db";
import { extensionUser, unauthorized } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

/** The reviewed answers for the application whose job is on this page. */
export async function GET(req: Request) {
  const userId = await extensionUser(req);
  if (!userId) return unauthorized();
  const url = new URL(req.url).searchParams.get("url") ?? "";
  try {
    const data = await extension.handoff(db(), userId, url);
    if (!data) return NextResponse.json({ error: "No CareerFlow application matches this page." }, { status: 404 });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.userMessage }, { status: 409 });
    throw err;
  }
}
