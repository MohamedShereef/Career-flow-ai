"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cvImport, tailor } from "@careerflow/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { runAction, str, type ActionState } from "@/lib/action";

export async function extractCvAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string | null = null;
  const state = await runAction(async () => {
    id = (await cvImport.extractFromCv(db(), user.id, str(fd, "documentId"))).id;
  });
  if (id) redirect(`/profile/import/${id}`);
  return state;
}

export async function applyImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const nums = (k: string) => fd.getAll(k).map(Number).filter((n) => Number.isInteger(n));
    const r = await cvImport.applyExtraction(db(), user.id, str(fd, "id"), {
      profileFields: fd.getAll("profileFields").map(String),
      experiences: nums("experiences"),
      qualifications: nums("qualifications"),
      skills: fd.getAll("skills").map(String),
      highlights: nums("highlights"),
    });
    revalidatePath("/", "layout");
    const parts = [
      r.profileFields && `${r.profileFields} profile details`,
      r.experiences && `${r.experiences} roles`,
      r.qualifications && `${r.qualifications} qualifications`,
      r.skills && `${r.skills} skills`,
      r.highlights && `${r.highlights} highlights (verify them in Verified highlights)`,
    ].filter(Boolean);
    return `Added ${parts.length ? parts.join(", ") : "nothing new"}.${r.skipped.length ? ` Skipped: ${r.skipped.join(" ")}` : ""}`;
  });
}

export async function tailorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string | null = null;
  const state = await runAction(async () => {
    id = (
      await tailor.tailorCv(db(), user.id, {
        jobTitle: str(fd, "jobTitle"),
        companyName: str(fd, "companyName"),
        jobDescription: str(fd, "jobDescription"),
        includeCoverLetter: fd.get("includeCoverLetter") === "on",
      })
    ).id;
  });
  if (id) redirect(`/jobs/tailored/${id}`);
  return state;
}

export async function approveTailoringAction(fd: FormData) {
  const user = await requireUser();
  await tailor.approveTailoring(db(), user.id, str(fd, "id"));
  revalidatePath(`/jobs/tailored/${str(fd, "id")}`);
}
