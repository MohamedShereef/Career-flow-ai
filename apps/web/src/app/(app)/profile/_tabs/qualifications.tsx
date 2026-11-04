import { profile } from "@careerflow/core";
import { addQualificationAction, addSkillsAction, deleteQualificationAction, deleteSkillAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Field, Select, TextArea, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";

const STATE_LABEL = { held: ["Held", "good"], in_progress: ["In progress", "attention"], expired: ["Expired", "neutral"] } as const;

export async function QualificationsTab({ userId }: { userId: string }) {
  const [quals, skills] = await Promise.all([profile.listQualifications(db(), userId), profile.listSkills(db(), userId)]);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Degrees & certifications" description="“In progress” items (e.g. studying CIPS) are never presented as completed.">
        <ul className="mb-5 divide-y divide-line">
          {quals.length === 0 && <li className="py-2 text-sm text-muted">Nothing added yet.</li>}
          {quals.map((q) => {
            const [label, tone] = STATE_LABEL[q.state as keyof typeof STATE_LABEL] ?? ["", "neutral"];
            return (
              <li key={q.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <div className="text-sm font-medium">{q.name}</div>
                  <div className="text-xs text-muted">{[q.issuer, q.obtainedOn && fmtDate(q.obtainedOn), q.kind].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={tone}>{label}</Badge>
                  <form action={deleteQualificationAction}><input type="hidden" name="id" value={q.id} /><button className="btn-danger" aria-label="Remove">✕</button></form>
                </div>
              </li>
            );
          })}
        </ul>
        <ActionForm action={addQualificationAction} className="space-y-3 border-t border-line pt-4" resetOnSuccess>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" name="name" placeholder="PMP" required />
            <Field label="Issuer" name="issuer" placeholder="PMI" />
            <Select label="Type" name="kind" options={[["certification", "Certification"], ["degree", "Degree"], ["course", "Course"], ["membership", "Membership"]]} />
            <Select label="Status" name="state" options={[["held", "Held"], ["in_progress", "In progress"], ["expired", "Expired"]]} />
            <Field label="Obtained on" name="obtainedOn" type="date" />
            <Field label="Expires on" name="expiresOn" type="date" />
          </div>
          <SubmitButton>Add qualification</SubmitButton>
        </ActionForm>
      </Card>
      <Card title="Skills" description="Tools, categories and competencies you can evidence in an interview.">
        <div className="mb-5 flex flex-wrap gap-2">
          {skills.length === 0 && <span className="text-sm text-muted">No skills yet.</span>}
          {skills.map((s) => (
            <form key={s.id} action={deleteSkillAction} className="inline-flex items-center gap-1 rounded-full border border-line bg-slate-50 py-0.5 pl-3 pr-1 text-sm">
              {s.name}
              <input type="hidden" name="id" value={s.id} />
              <button className="rounded-full px-1.5 text-muted hover:bg-bad-50 hover:text-bad" aria-label={`Remove ${s.name}`}>✕</button>
            </form>
          ))}
        </div>
        <ActionForm action={addSkillsAction} className="space-y-3 border-t border-line pt-4" resetOnSuccess>
          <TextArea label="Add skills" name="skills" placeholder={"Strategic sourcing, Contract negotiation, SAP MM, MEP packages"} hint="Separate with commas or new lines." rows={3} />
          <Field label="Category (optional)" name="category" placeholder="Procurement / Systems / Commercial" />
          <SubmitButton>Add skills</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
