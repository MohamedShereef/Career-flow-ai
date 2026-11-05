"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { applications, autoapply } from "@careerflow/core";
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

export async function autoApplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string | null = null;
  const state = await runAction(async () => {
    id = (await autoapply.startAutoApply(db(), user.id, { jobId: str(fd, "jobId"), tailoringId: str(fd, "tailoringId") || null })).id;
  });
  if (id) redirect(`/applications/${id}`);
  return state;
}

export async function approveApplicationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await autoapply.approve(db(), user.id, str(fd, "previewId"));
    revalidatePath("/", "layout");
    return "Approved. CareerFlow is submitting it now — this page updates in a minute.";
  });
}

export async function cancelApplicationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await autoapply.cancel(db(), user.id, str(fd, "applicationId"));
    revalidatePath("/", "layout");
    return "Cancelled. Nothing was sent.";
  });
}

export async function retryApplicationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const d = await autoapply.getDetail(db(), user.id, str(fd, "applicationId"));
    await autoapply.startAutoApply(db(), user.id, { jobId: d.job.id });
    revalidatePath("/", "layout");
    return "Started again.";
  });
}

export async function resolveUncertainAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const yes = str(fd, "wentThrough") === "1";
    await autoapply.resolveUncertain(db(), user.id, str(fd, "applicationId"), yes);
    revalidatePath("/", "layout");
    return yes ? "Recorded as applied." : "Recorded as not sent.";
  });
}

export async function autopilotAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const field = str(fd, "field");
    const on = str(fd, "on") === "1";
    await autoapply.setAutopilot(db(), user.id, field === "autoSubmit" ? { autoSubmit: on } : { prepare: on });
    revalidatePath("/", "layout");
    return on ? (field === "autoSubmit" ? "Autopilot will now submit when every answer is verified." : "Autopilot is on. It picks your best matches every hour.") : "Turned off.";
  });
}

export async function useApplyLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const d = await autoapply.getDetail(db(), user.id, str(fd, "applicationId"));
    await autoapply.startAutoApply(db(), user.id, { jobId: d.job.id, applyUrl: str(fd, "applyUrl") });
    revalidatePath("/", "layout");
    return "Got it — opening the employer's page now. This page updates in a minute.";
  });
}
