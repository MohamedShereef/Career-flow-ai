import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, extension } from "@careerflow/core";
import { db } from "@/lib/db";
import { extensionUser, unauthorized } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

const body = z.object({ applicationId: z.string().uuid(), url: z.string().max(2000).default(""), confirmation: z.string().max(500).default("") });

/** The user pressed Submit in Chrome and the employer's page confirmed it (or they said so). */
export async function POST(req: Request) {
  const userId = await extensionUser(req);
  if (!userId) return unauthorized();
  const r = body.safeParse(await req.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const out = await extension.markSent(db(), userId, r.data.applicationId, { url: r.data.url, confirmation: r.data.confirmation });
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.userMessage }, { status: err.status });
    throw err;
  }
}
