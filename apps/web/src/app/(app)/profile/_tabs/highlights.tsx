import { profile } from "@careerflow/core";
import { addFactAction, deleteFactAction, rejectFactAction, verifyFactAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, Select, TextArea } from "@/components/ui";
import { db } from "@/lib/db";

const CATEGORIES: Array<[string, string]> = [
  ["achievement", "Achievement"],
  ["contract_value", "Contract value"],
  ["team_size", "Team size / management"],
  ["savings", "Cost savings"],
  ["package", "Package / scope handled"],
  ["other", "Other"],
];

export async function HighlightsTab({ userId }: { userId: string }) {
  const [facts, exps] = await Promise.all([profile.listCareerFacts(db(), userId), profile.listExperiences(db(), userId)]);
  const fmt = (n: string | null, unit: string | null) => (n === null ? null : `${unit ?? ""} ${Number(n).toLocaleString("en-US")}`.trim());
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-3">
        <div className="rounded-xl border border-attention/30 bg-attention-50 p-4 text-sm text-attention">
          Only <strong>verified</strong> highlights can appear in tailored CVs and cover letters. For any number, confirm exactly what it means — e.g. “single contract I negotiated” vs “cumulative total”.
        </div>
        {facts.length === 0 && <EmptyState title="No highlights yet">Add measurable achievements: contract values, savings, team size, critical supplier replacements.</EmptyState>}
        {facts.map((f) => (
          <div key={f.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm">{f.statement}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                  <span>{CATEGORIES.find(([k]) => k === f.category)?.[1]}</span>
                  {fmt(f.numericValue, f.unit) && <span>· {fmt(f.numericValue, f.unit)}</span>}
                  {f.meaning && <span>· means: {f.meaning}</span>}
                </div>
              </div>
              <Badge tone={f.status === "verified" ? "good" : f.status === "rejected" ? "bad" : "attention"}>{f.status === "draft" ? "Needs verification" : f.status === "verified" ? "Verified" : "Rejected"}</Badge>
            </div>
            {f.status !== "verified" && (
              <ActionForm action={verifyFactAction} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <input type="hidden" name="id" value={f.id} />
                {f.numericValue !== null && (
                  <div className="min-w-56 flex-1">
                    <Field label="What exactly does this number mean?" name="meaning" defaultValue={f.meaning ?? ""} placeholder="Value of one contract I negotiated individually" />
                  </div>
                )}
                <SubmitButton className="btn-primary" pendingText="Verifying…">I confirm this is accurate</SubmitButton>
              </ActionForm>
            )}
            <div className="mt-2 flex gap-1">
              {f.status === "verified" && (
                <form action={rejectFactAction}><input type="hidden" name="id" value={f.id} /><button className="btn-ghost text-xs">Un-verify</button></form>
              )}
              <form action={deleteFactAction}><input type="hidden" name="id" value={f.id} /><button className="btn-danger text-xs">Delete</button></form>
            </div>
          </div>
        ))}
      </div>
      <div className="lg:col-span-2">
        <Card title="Add a highlight">
          <ActionForm action={addFactAction} className="space-y-3" resetOnSuccess>
            <Select label="Type" name="category" options={CATEGORIES} />
            <TextArea label="Statement (as it may appear on a CV)" name="statement" required rows={3} placeholder="Replaced the supplier of a critical material mid-project without delaying the schedule." />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Number (optional)" name="numericValue" inputMode="decimal" placeholder="60000000" />
              <Field label="Unit" name="unit" placeholder="SAR / people / %" />
            </div>
            <Field label="What the number means" name="meaning" placeholder="Single contract value" />
            <Select label="Linked role (optional)" name="workExperienceId" options={[["", "—"], ...exps.map((e) => [e.id, `${e.title} · ${e.employer}`] as [string, string])]} />
            <SubmitButton>Save as draft</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
