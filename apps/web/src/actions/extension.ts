"use server";

import { revalidatePath } from "next/cache";
import { extension } from "@careerflow/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { runAction, str, type ActionState } from "@/lib/action";

/** A new link code for the Chrome extension, shown once. */
export async function createExtensionCodeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const { token } = await extension.createToken(db(), user.id, str(fd, "name") || "Chrome");
    revalidatePath("/settings");
    return token;
  });
}

export async function unlinkExtensionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await extension.revokeToken(db(), user.id, str(fd, "id"));
    revalidatePath("/settings");
    return "Unlinked.";
  });
}
