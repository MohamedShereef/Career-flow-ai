import { profile } from "@careerflow/core";
import { deleteExperienceAction, saveExperienceAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, TextArea, fmtMonth } from "@/components/ui";
import { db } from "@/lib/db";

function ExperienceForm({ e }: { e?: Awaited<ReturnType<typeof profile.listExperiences>>[number] }) {
  return (
    <ActionForm action={saveExperienceAction} className="space-y-4" resetOnSuccess={!e}>
      {e && <input type="hidden" name="id" value={e.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Job title" name="title" defaultValue={e?.title} required />
        <Field label="Employer" name="employer" defaultValue={e?.employer} required />
        <Field label="Location" name="location" defaultValue={e?.location ?? ""} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start" name="startDate" type="month" defaultValue={e?.startDate.slice(0, 7)} required />
          <Field label="End" name="endDate" type="month" defaultValue={e?.endDate?.slice(0, 7) ?? ""} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isCurrent" defaultChecked={e?.isCurrent} className="accent-brand-600" /> I currently work here
      </label>
      <TextArea label="Responsibilities & scope" name="description" defaultValue={e?.description ?? ""} rows={5} hint="Packages handled, categories, systems used. Put numbers in Verified highlights instead." />
      <SubmitButton>{e ? "Save changes" : "Add experience"}</SubmitButton>
    </ActionForm>
  );
}

export async function ExperienceTab({ userId }: { userId: string }) {
  const items = await profile.listExperiences(db(), userId);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        {items.length === 0 && <EmptyState title="No experience yet">Add your roles, most recent first. Dates must be exact — they appear on every CV.</EmptyState>}
        {items.map((e) => (
          <details key={e.id} className="card group p-5">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{e.title}</div>
                <div className="text-sm text-muted">{e.employer}{e.location ? ` · ${e.location}` : ""}</div>
                <div className="mt-1 text-xs text-muted">{fmtMonth(e.startDate)} – {e.isCurrent ? "Present" : fmtMonth(e.endDate)}</div>
              </div>
              <div className="flex items-center gap-2">
                {e.isCurrent && <Badge tone="brand">Current</Badge>}
                <span className="text-xs text-brand-600 group-open:hidden">Edit</span>
              </div>
            </summary>
            <div className="mt-4 border-t border-line pt-4">
              <ExperienceForm e={e} />
              <form action={deleteExperienceAction} className="mt-2">
                <input type="hidden" name="id" value={e.id} />
                <button className="btn-danger">Delete this role</button>
              </form>
            </div>
          </details>
        ))}
      </div>
      <div className="lg:col-span-2">
        <Card title="Add a role"><ExperienceForm /></Card>
      </div>
    </div>
  );
}
