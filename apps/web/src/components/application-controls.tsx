import { cancelApplicationAction, deleteApplicationAction } from "@/actions/applications";
import { ActionForm, SubmitButton } from "@/components/forms";

/** Statuses where something may have reached the employer — those stay in history. */
const SENT = new Set(["submitted_unverified", "confirmed_by_email", "interview", "rejected"]);

export function canCancel(a: { status: string; checkpoint: string | null }) {
  return !SENT.has(a.status) && a.status !== "withdrawn" && a.checkpoint !== "uncertain" && a.checkpoint !== "submitting";
}
export function canDelete(a: { status: string; checkpoint: string | null }) {
  return !SENT.has(a.status) && a.checkpoint !== "uncertain" && a.checkpoint !== "submitting";
}

/** Cancel (stop, keep in history) and Delete (remove; the job can be started again). */
export function ApplicationControls({ app, from, small = false }: { app: { id: string; status: string; checkpoint: string | null }; from: "list" | "detail"; small?: boolean }) {
  const cls = small ? "text-xs font-medium hover:underline" : "";
  return (
    <div className="flex flex-wrap items-center gap-3">
      {canCancel(app) && (
        <ActionForm action={cancelApplicationAction}>
          <input type="hidden" name="applicationId" value={app.id} />
          <SubmitButton className={small ? `${cls} text-slate-600` : "btn-secondary"} pendingText="Cancelling…" confirm="Stop this application? Nothing will be sent.">
            Cancel
          </SubmitButton>
        </ActionForm>
      )}
      {canDelete(app) && (
        <ActionForm action={deleteApplicationAction}>
          <input type="hidden" name="applicationId" value={app.id} />
          <input type="hidden" name="from" value={from} />
          <SubmitButton className={small ? `${cls} text-bad` : "btn-secondary text-bad"} pendingText="Deleting…" confirm="Delete this application and its history? Nothing was sent, and you can start this job again later.">
            Delete
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
