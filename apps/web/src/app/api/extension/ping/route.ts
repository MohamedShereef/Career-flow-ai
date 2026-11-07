import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@careerflow/db";
import { db } from "@/lib/db";
import { extensionUser, unauthorized } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await extensionUser(req);
  if (!userId) return unauthorized();
  const [u] = await db().select({ email: users.email }).from(users).where(eq(users.id, userId));
  return NextResponse.json({ ok: true, email: u?.email ?? "" });
}
