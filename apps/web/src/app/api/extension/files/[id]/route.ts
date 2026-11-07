import { NextResponse } from "next/server";
import { AppError, extension } from "@careerflow/core";
import { db } from "@/lib/db";
import { extensionUser, unauthorized } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

/** One of the user's own files (tailored CV, cover letter, certificate) to attach. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await extensionUser(req);
  if (!userId) return unauthorized();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const { doc, bytes } = await extension.fileFor(db(), userId, id);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": doc.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    return new NextResponse("Not found", { status: err instanceof AppError ? err.status : 500 });
  }
}
