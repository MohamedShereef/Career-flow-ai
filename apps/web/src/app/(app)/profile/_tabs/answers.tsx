import { answers } from "@careerflow/core";
import { deleteAnswerAction, saveAnswerAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, Select, TextArea } from "@/components/ui";
import { db } from "@/lib/db";

const SENS: Record<string, string> = {
  legal_declaration: "Legal declaration",
  protected_category: "Protected category",
  identity_attestation: "Identity",
  conflict_of_interest: "Conflict of interest",
  salary: "Salary",
};

export async function AnswersTab({ userId }: { userId: string }) {
  const rows = await answers.listAnswers(db(), userId);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-3">
        {rows.length === 0 && <EmptyState title="No saved answers yet">Save answers to questions employers often ask — work authorization, notice period, relocation. The agent reuses them automatically.</EmptyState>}
        {rows.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{a.questionText}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{a.answer}</p>
              </div>
              <form action={deleteAnswerAction}><input type="hidden" name="id" value={a.id} /><button className="btn-danger text-xs">Delete</button></form>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={a.scope === "global" ? "neutral" : "brand"}>{a.scope === "global" ? "All employers" : `Only: ${a.employerKey}`}</Badge>
              {SENS[a.sensitivity] && <Badge tone="attention">{SENS[a.sensitivity]}</Badge>}
              {a.requiresReview && <Badge tone="attention">You review before each submit</Badge>}
              <span className="text-xs text-muted">Used {a.useCount}×</span>
            </div>
          </div>
        ))}
      </div>
      <div className="lg:col-span-2">
        <Card title="Add an answer" description="Answers are encrypted. Legal and identity answers are always shown to you before submission.">
          <ActionForm action={saveAnswerAction} className="space-y-3" resetOnSuccess>
            <TextArea label="Question" name="questionText" required rows={2} placeholder="Are you legally authorized to work in Saudi Arabia?" />
            <TextArea label="Your answer" name="answer" required rows={3} />
            <Select label="Applies to" name="scope" options={[["global", "All employers"], ["employer", "One employer only"]]} />
            <Field label="Employer (if one employer only)" name="employerName" />
            <SubmitButton>Save answer</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
