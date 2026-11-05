"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AppError, discovery, matching, queue, tailor } from "@careerflow/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { runAction, str, type ActionState } from "@/lib/action";

export async function runDiscoveryAction(_s: ActionState, _fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await queue.enqueue(db(), { kind: "discovery.run_all", userId: user.id, payload: { trigger: "manual" }, dedupeKey: "discovery:all:manual" });
    await queue.enqueue(db(), { kind: "matching.run_user", userId: user.id, payload: { userId: user.id }, dedupeKey: `matching:user:${user.id}`, runAt: new Date(Date.now() + 3 * 60_000) });
    return "Searching all job boards now. New matches appear here in a few minutes.";
  });
}

export async function reindexAction(_s: ActionState, _fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const { count, staleBefore } = await matching.reindexUser(db(), user.id);
    await queue.enqueue(db(), {
      kind: "matching.run_user",
      userId: user.id,
      payload: { userId: user.id, staleBefore: staleBefore.toISOString() },
      dedupeKey: `matching:reindex:${user.id}`,
      timeoutSeconds: 900,
    });
    revalidatePath("/jobs");
    return `Re-scoring ${count} jobs against your current profile. Current results stay on screen and update one by one — refresh in a few minutes.`;
  });
}

export async function tailorForJobAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string | null = null;
  const state = await runAction(async () => {
    const m = await matching.getMatch(db(), user.id, str(fd, "jobId"));
    if (!m) throw new AppError("not_found", "Job not found.", 404);
    if (!m.j.description) throw new AppError("no_description", "This posting has no description to tailor against. Open it and paste the description in “Tailor my CV”.");
    id = (await tailor.tailorCv(db(), user.id, { jobTitle: m.j.title, companyName: m.j.companyName, jobDescription: m.j.description, includeCoverLetter: true, jobId: m.j.id })).id;
  });
  if (id) redirect(`/jobs/tailored/${id}`);
  return state;
}

export async function addSourceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const input = { kind: str(fd, "kind"), name: str(fd, "name"), identifier: str(fd, "identifier") };
    if (fd.get("intent") === "test") {
      const r = await discovery.testSource(db(), input);
      return `Found ${r.total} postings, ${r.relevant} procurement-family.${r.sample.length ? ` e.g. ${r.sample.join(" · ")}` : ""}`;
    }
    const src = await discovery.addSource(db(), user.id, input);
    await queue.enqueue(db(), { kind: "discovery.run_source", payload: { sourceId: src.id, trigger: "manual" }, dedupeKey: `discovery:${src.id}`, timeoutSeconds: 900 });
    revalidatePath("/settings");
    return "Added. The first search runs in the background now.";
  });
}

export async function toggleSourceAction(fd: FormData) {
  const user = await requireUser();
  await discovery.setSourceEnabled(db(), user.id, str(fd, "id"), str(fd, "enabled") === "1");
  revalidatePath("/settings");
}
