"use client";

import { useActionState } from "react";
import { createExtensionCodeAction } from "@/actions/extension";
import { CopyText } from "@/components/copy-text";

/** Creates a link code and shows it once, with the address to paste into the extension. */
export function ExtensionLink({ server }: { server: string }) {
  const [state, action, pending] = useActionState(createExtensionCodeAction, undefined);
  return (
    <div className="space-y-3">
      <form action={action}>
        <input type="hidden" name="name" value="Chrome" />
        <button className="btn-primary" disabled={pending}>{pending ? "Creating…" : "Create link code"}</button>
      </form>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.ok && (
        <div className="space-y-2 rounded-lg border border-line bg-slate-50 p-3 text-sm">
          <p>Paste these into the extension (the code is shown only now):</p>
          <p><span className="text-muted">CareerFlow address:</span> <code>{server}</code></p>
          <CopyText text={state.ok} label="Copy link code" />
        </div>
      )}
    </div>
  );
}
