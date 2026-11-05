import { feedback } from "@careerflow/core";
import { notInterestedAction } from "@/actions/jobs";
import { ActionForm, SubmitButton } from "@/components/forms";

/** "Not interested" with a reason — CareerFlow learns from it. */
export function NotInterested({ jobId, compact = false }: { jobId: string; compact?: boolean }) {
  return (
    <details className={compact ? "text-xs" : "text-sm"}>
      <summary className="cursor-pointer select-none text-muted hover:text-ink">Not interested</summary>
      <ActionForm action={notInterestedAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="jobId" value={jobId} />
        <select name="reason" className="input max-w-xs" defaultValue="role">
          {Object.entries(feedback.REASONS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input name="note" className="input max-w-xs" placeholder="Anything to add (optional)" maxLength={200} />
        <SubmitButton className="btn-secondary" pendingText="Saving…">Save</SubmitButton>
      </ActionForm>
    </details>
  );
}
