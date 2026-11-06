"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { applications, autoapply, gmail, logins, queue, replies } from "@careerflow/core";
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

export async function deleteApplicationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await autoapply.deleteApplication(db(), user.id, str(fd, "applicationId"));
    revalidatePath("/", "layout");
    if (str(fd, "from") === "detail") redirect("/applications");
    return "Deleted. You can start this job again any time.";
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

export async function saveLoginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await logins.saveLogin(db(), user.id, { url: str(fd, "url"), username: str(fd, "username"), password: String(fd.get("password") ?? ""), label: str(fd, "label") || null });
    const applicationId = str(fd, "applicationId");
    revalidatePath("/", "layout");
    if (applicationId) {
      const d = await autoapply.getDetail(db(), user.id, applicationId);
      await autoapply.startAutoApply(db(), user.id, { jobId: d.job.id });
      return "Login saved. CareerFlow is signing in and continuing the application.";
    }
    return "Login saved. It's used only on that portal.";
  });
}

export async function deleteLoginAction(fd: FormData) {
  const user = await requireUser();
  await logins.deleteLogin(db(), user.id, str(fd, "id"));
  revalidatePath("/settings");
}

export async function connectGmailAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await gmail.connect(db(), user.id, { email: str(fd, "email"), appPassword: String(fd.get("appPassword") ?? "") });
    await queue.enqueue(db(), { kind: "gmail.sync_user", userId: user.id, payload: { userId: user.id }, dedupeKey: `gmail:${user.id}`, timeoutSeconds: 900 });
    revalidatePath("/", "layout");
    return "Gmail connected. Reading job-related emails from the last 3 weeks now — results appear in Applications in a few minutes.";
  });
}

export async function syncGmailAction(_: ActionState, _fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await queue.enqueue(db(), { kind: "gmail.sync_user", userId: user.id, payload: { userId: user.id }, dedupeKey: `gmail:${user.id}`, timeoutSeconds: 900 });
    return "Checking your inbox now.";
  });
}

export async function disconnectGmailAction(fd: FormData) {
  void fd;
  const user = await requireUser();
  await gmail.disconnect(db(), user.id);
  revalidatePath("/", "layout");
}

export async function draftReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const id = str(fd, "emailId");
    await replies.draftReply(db(), user.id, id, { chosenTime: str(fd, "chosenTime") || null });
    revalidatePath(`/emails/${id}`);
    return "Reply drafted. Check it below.";
  });
}

export async function sendReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await replies.sendDraft(db(), user.id, str(fd, "draftId"), String(fd.get("body") ?? ""));
    revalidatePath("/", "layout");
    return "Sent from your Gmail, in the same thread.";
  });
}

export async function discardReplyAction(fd: FormData) {
  const user = await requireUser();
  await replies.discardDraft(db(), user.id, str(fd, "draftId"));
  revalidatePath(`/emails/${str(fd, "emailId")}`);
}

export async function saveAvailabilityAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await replies.setAvailability(db(), user.id, str(fd, "availability"));
    revalidatePath("/settings");
    return "Saved. Replies that share your availability will use exactly this.";
  });
}
