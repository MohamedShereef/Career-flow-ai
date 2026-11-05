import { NextResponse } from "next/server";
import { AppError, applications } from "@careerflow/core";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Records that the user opened the employer's application page, then sends them there. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const r = await applications.prepare(db(), user.id, id);
    return NextResponse.redirect(r.applyUrl, 303);
  } catch (err) {
    const msg = err instanceof AppError ? err.userMessage : "Something went wrong.";
    return NextResponse.redirect(new URL(`/jobs/tailored/${id}?error=${encodeURIComponent(msg)}`, req.url), 303);
  }
}
