import { resetPasswordAction } from "@/actions/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field } from "@/components/ui";

export const metadata = { title: "Choose a new password" };

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-lg font-semibold">Choose a new password</h1>
      <ActionForm action={resetPasswordAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        <SubmitButton className="btn-primary w-full">Update password</SubmitButton>
      </ActionForm>
    </>
  );
}
