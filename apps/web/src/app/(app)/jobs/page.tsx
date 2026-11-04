import Link from "next/link";
import { ai, tailor } from "@careerflow/core";
import { tailorAction } from "@/actions/cv";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, PageHeader, TextArea, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Jobs" };

export default async function Jobs() {
  const user = await requireUser();
  const items = await tailor.listTailorings(db(), user.id);
  const aiReady = ai.aiConfigured();
  return (
    <>
      <PageHeader title="Jobs" subtitle="Tailor your CV to any job now. Automatic job discovery and matching come next." />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card title="Tailor my CV for a job" description="Paste a job you found. You get an ATS-friendly PDF CV and cover letter built only from your verified profile.">
            {!aiReady ? (
              <p className="rounded-lg bg-attention-50 p-3 text-sm text-attention">The AI engine isn't connected yet. Add your OpenAI API key on the server to turn this on.</p>
            ) : (
              <ActionForm action={tailorAction} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Job title" name="jobTitle" required placeholder="Senior Procurement Engineer" />
                  <Field label="Company" name="companyName" required placeholder="FCC Construcción" />
                </div>
                <TextArea label="Job description" name="jobDescription" required rows={10} placeholder="Paste the full job description here…" />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="includeCoverLetter" defaultChecked className="accent-brand-600" /> Also write a cover letter
                </label>
                <SubmitButton pendingText="Tailoring… (about a minute)">Create tailored CV</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Card title="Tailored CVs">
            {items.length === 0 ? (
              <EmptyState title="None yet">Your tailored CVs and letters appear here, ready to download.</EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <Link href={`/jobs/tailored/${t.id}`} className="min-w-0">
                      <div className="truncate text-sm font-medium text-brand-700 hover:underline">{t.jobTitle}</div>
                      <div className="truncate text-xs text-muted">{t.companyName} · {fmtDate(t.createdAt)}</div>
                    </Link>
                    {t.approvedAt ? <Badge tone="good">Approved</Badge> : <Badge>Draft</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
