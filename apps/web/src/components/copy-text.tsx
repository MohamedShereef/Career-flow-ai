"use client";

import { useState } from "react";

/** A read-only block of text with a Copy button (for sending technical details to support). */
export function CopyText({ text, label = "Copy technical details" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const ta = document.getElementById("cf-tech") as HTMLTextAreaElement | null;
            ta?.select();
            document.execCommand("copy");
          }
          setDone(true);
          setTimeout(() => setDone(false), 2500);
        }}
      >
        {done ? "Copied ✓" : label}
      </button>
      <textarea id="cf-tech" readOnly value={text} className="h-48 w-full rounded-lg border border-line bg-slate-50 p-2 font-mono text-xs" />
    </div>
  );
}
