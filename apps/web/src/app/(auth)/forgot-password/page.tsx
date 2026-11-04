import Link from "next/link";
import { forgotPasswordAction } from "@/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field } from "@/components/ui";

export const metadata = { title: "Reset password" };

export default function Forgot() {
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">Reset your password</h1>
      <p className="mb-4 text-sm text-muted">We'll email you a link that works for 60 minutes.</p>
      <ActionForm action={forgotPasswordAction} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <SubmitButton className="btn-primary w-full" pendingText="Sending…">Send reset link</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="text-brand-600 hover:underline">Back to sign in</Link></p>
    </>
  );
}
