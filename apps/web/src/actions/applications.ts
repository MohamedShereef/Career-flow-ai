"use server";

import { revalidatePath } from "next/cache";
import { applications } from "@careerflow/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { runAction, str, type ActionState } from "@/lib/action";

export async function saveApplyLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const id = str(fd, "tailoringId");
    await applications.prepare(db(), user.id, id, str(fd, "applyUrl"));
    revalidatePath(`/jobs/tailored/${id}`);
    return "Saved. Press “Apply on the employer's site”.";
  });
}

export async function markSubmittedAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const r = await applications.markSubmitted(db(), user.id, str(fd, "applicationId"));
    revalidatePath("/", "layout");
    return r.alreadyRecorded ? "Already recorded." : "Recorded. It's now tracked in Applications.";
  });
}
