import Link from "next/link";
import { loginAction } from "@/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      {sp.reset && <p className="mb-4 rounded-lg bg-good-50 px-3 py-2 text-sm text-good">Password updated. Sign in with your new password.</p>}
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ""} />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <SubmitButton className="btn-primary w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <div className="mt-4 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-brand-600 hover:underline">Forgot password?</Link>
        <Link href="/signup" className="text-brand-600 hover:underline">Create account</Link>
      </div>
    </>
  );
}
