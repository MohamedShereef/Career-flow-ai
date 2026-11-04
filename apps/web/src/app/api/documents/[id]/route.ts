import { NextResponse } from "next/server";
import { AppError, documents } from "@careerflow/core";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Authenticated, ownership-checked download. Files are never publicly addressable. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  try {
    const { doc, bytes } = await documents.getDocumentForDownload(db(), user.id, id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const status = err instanceof AppError ? err.status : 500;
    return new NextResponse(status === 404 ? "Not found" : "Error", { status });
  }
}
