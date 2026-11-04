import Link from "next/link";
import { signupAction } from "@/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field } from "@/components/ui";

export const metadata = { title: "Create account" };

export default function Signup() {
  return (
    <>
      <h1 className="mb-4 text-lg font-semibold">Create your account</h1>
      <ActionForm action={signupAction} className="space-y-4">
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} required hint="At least 10 characters, mixing letters with numbers or symbols." />
        <SubmitButton className="btn-primary w-full" pendingText="Creating…">Create account</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account? <Link href="/login" className="text-brand-600 hover:underline">Sign in</Link>
      </p>
    </>
  );
}
