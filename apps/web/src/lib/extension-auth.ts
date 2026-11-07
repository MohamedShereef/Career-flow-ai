import { NextResponse } from "next/server";
import { extension } from "@careerflow/core";
import { db } from "@/lib/db";

/** The account behind the extension's "Authorization: Bearer cfx_…" header. */
export async function extensionUser(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : null;
  return extension.authenticate(db(), token);
}

export const unauthorized = () => NextResponse.json({ error: "Link code not valid. Create a new one in CareerFlow → Settings → Chrome extension." }, { status: 401 });
