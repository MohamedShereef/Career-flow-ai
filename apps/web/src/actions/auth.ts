"use server";

import { redirect } from "next/navigation";
import { AppError, auth } from "@careerflow/core";
import { db } from "@/lib/db";
import { appUrl, mailConfigured, sendMail } from "@/lib/mailer";
import { clearSessionCookie, requestContext, requireUser, sessionToken, setSessionCookie } from "@/lib/session";
import { runAction, str, type ActionState } from "@/lib/action";

export async function signupAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let ok = false;
  const state = await runAction(async () => {
    const res = await auth.signUp(
      db(),
      { email: str(fd, "email"), password: str(fd, "password"), displayName: str(fd, "name") },
      await requestContext(),
    );
    await setSessionCookie(res.token, res.expiresAt);
    ok = true;
  });
  if (ok) redirect("/profile?welcome=1");
  return state;
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let ok = false;
  const state = await runAction(async () => {
    const res = await auth.signIn(db(), { email: str(fd, "email"), password: str(fd, "password") }, await requestContext());
    await setSessionCookie(res.token, res.expiresAt);
    ok = true;
  });
  if (ok) {
    const next = str(fd, "next");
    redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/home");
  }
  return state;
}

export async function logoutAction() {
  const token = await sessionToken();
  if (token) await auth.signOut(db(), token);
  await clearSessionCookie();
  redirect("/login");
}

export async function forgotPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    // Checked before the lookup so the response never reveals whether an account exists.
    if (!mailConfigured()) {
      throw new AppError("email_not_configured", "Password-reset email isn't set up on this server yet. The admin can create a reset link from the server.", 503);
    }
    const r = await auth.requestPasswordReset(db(), str(fd, "email"), await requestContext());
    if (r) {
      const link = `${appUrl()}/reset-password?token=${encodeURIComponent(r.token)}`;
      await sendMail(
        r.email,
        "Reset your CareerFlow AI password",
        `Someone asked to reset the password for this account.\n\nReset it here (valid for 60 minutes):\n${link}\n\nIf this wasn't you, ignore this email — your password stays the same.`,
      );
    }
    return "If an account exists for that email, a reset link is on its way.";
  });
}

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let ok = false;
  const state = await runAction(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new AppError("mismatch", "The two passwords don't match.");
    await auth.resetPassword(db(), str(fd, "token"), str(fd, "password"), await requestContext());
    ok = true;
  });
  if (ok) redirect("/login?reset=1");
  return state;
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const s = await auth.changePassword(db(), user.id, str(fd, "current"), str(fd, "password"), await requestContext());
    await setSessionCookie(s.token, s.expiresAt);
    return "Password changed. Other devices were signed out.";
  });
}

export async function signOutOtherSessionsAction(): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await auth.revokeOtherSessions(db(), user.id, user.sessionId);
    return "Signed out of all other devices.";
  });
}
