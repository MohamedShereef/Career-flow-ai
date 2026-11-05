import { answers } from "@careerflow/core";
import { answerQuestionAction, dismissQuestionAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, EmptyState, Select, TextArea, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";

export async function QuestionsTab({ userId }: { userId: string }) {
  const open = await answers.listPendingQuestions(db(), userId, "open");
  if (!open.length) {
    return (
      <EmptyState title="No questions waiting">
        When an application asks something your profile and saved answers don't cover, it appears here with the employer's exact wording. Answer once and the application continues.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      {open.map((q) => (
        <div key={q.id} className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">“{q.questionText}”</p>
              <p className="mt-1 text-xs text-muted">{[q.employerName, q.jobTitle, fmtDate(q.createdAt)].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="flex gap-2">
              {q.required && <Badge tone="attention">Required</Badge>}
              {q.sensitivity !== "normal" && <Badge tone="attention">Sensitive</Badge>}
            </div>
          </div>
          {q.context && <p className={`mt-2 text-sm ${/rejected/.test(q.context) ? "rounded-lg bg-attention-50 p-2 text-attention" : "text-muted"}`}>{q.context}</p>}
          <ActionForm action={answerQuestionAction} className="mt-4 space-y-3">
            <input type="hidden" name="id" value={q.id} />
            {q.options?.length ? (
              <>
                <Select label="Your answer (the site's options)" name="answer" options={q.options.map((o) => [o, o] as [string, string])} />
                {q.options.length >= 10 && <TextArea label="Not in the list? Type it exactly as the site writes it" name="answerText" rows={1} />}
              </>
            ) : (
              <TextArea label="Your answer" name="answer" required rows={2} />
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <Select
                  label="Reuse this answer for"
                  name="scope"
                  options={q.employerName ? [["global", "All employers"], ["employer", `Only ${q.employerName}`]] : [["global", "All employers"]]}
                />
              </div>
              <SubmitButton>Save & continue</SubmitButton>
            </div>
          </ActionForm>
          <form action={dismissQuestionAction} className="mt-2">
            <input type="hidden" name="id" value={q.id} />
            <button className="btn-ghost text-xs">Dismiss</button>
          </form>
        </div>
      ))}
    </div>
  );
}
