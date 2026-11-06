"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type State = { ok?: string; error?: string; at?: number } | undefined;

const PendingContext = createContext<boolean | null>(null);

export function SubmitButton({ children, className = "btn-primary", pendingText, confirm }: { children: ReactNode; className?: string; pendingText?: string; confirm?: string }) {
  const ctx = useContext(PendingContext);
  const { pending: formPending } = useFormStatus();
  const pending = ctx ?? formPending;
  return (
    <button type="submit" className={className} disabled={pending} onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}>
      {pending ? (pendingText ?? "Saving…") : children}
    </button>
  );
}

/**
 * Form bound to a server action that returns {ok|error}; shows the result inline.
 * Submits via onSubmit (not the `action` prop) so React doesn't clear what the
 * user typed when the server returns a validation error.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: (state: State, fd: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <PendingContext.Provider value={pending}>
      <form
        ref={ref}
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          // Include the clicked button (name/value) so one form can have several actions.
          const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
          const fd = new FormData(e.currentTarget, submitter);
          startTransition(() => formAction(fd));
        }}
      >
        {children}
        {state?.error && (
          <p role="alert" className="mt-3 rounded-lg bg-bad-50 px-3 py-2 text-sm text-bad">
            {state.error}
          </p>
        )}
        {state?.ok && !state.error && (
          <p role="status" className="mt-3 rounded-lg bg-good-50 px-3 py-2 text-sm text-good">
            {state.ok}
          </p>
        )}
      </form>
    </PendingContext.Provider>
  );
}
