import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, cvImport } from "@careerflow/core";
import { applyImportAction } from "@/actions/cv";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Review CV import" };

const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  headline: "Headline",
  summary: "Summary",
  phone: "Phone",
  contactEmail: "Email",
  linkedinUrl: "LinkedIn",
  city: "City",
  nationality: "Nationality",
  yearsExperience: "Years of experience",
};

function Check({ name, value, children, defaultChecked = true }: { name: string; value: string | number; children: React.ReactNode; defaultChecked?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 hover:bg-slate-50">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="mt-1 accent-brand-600" />
      <div className="min-w-0 text-sm">{children}</div>
    </label>
  );
}

export default async function ImportReview({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let x;
  try {
    x = await cvImport.getExtraction(db(), user.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const d = x.data;
  if (!d) {
    return (
      <>
        <PageHeader title="CV import" />
        <p className="text-sm text-muted">This import didn't finish. Go back and try again.</p>
      </>
    );
  }
  const fields = Object.entries({
    fullName: d.fullName,
    headline: d.headline,
    summary: d.summary,
    phone: d.phone,
    contactEmail: d.email,
    linkedinUrl: d.linkedinUrl,
    city: d.city,
    nationality: d.nationality,
    yearsExperience: d.yearsExperience,
  }).filter(([, v]) => v !== null && v !== "");

  return (
    <>
      <PageHeader
        title="Review what we read from your CV"
        subtitle={<>From <strong>{x.filename}</strong>. Untick anything that's wrong. Nothing is saved until you press “Add to my profile”.</>}
        actions={<Link href="/profile?tab=documents" className="btn-secondary">Back</Link>}
      />
      {d.warnings.length > 0 && (
        <div className="mb-6 rounded-xl border border-attention/30 bg-attention-50 p-4 text-sm text-attention">
          <strong>Check these:</strong>
          <ul className="mt-1 list-disc pl-5">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <ActionForm action={applyImportAction} className="space-y-6">
        <input type="hidden" name="id" value={x.id} />
        {fields.length > 0 && (
          <Card title="Profile details" description="Selected fields replace what's currently in Personal details.">
            <div className="grid gap-2 md:grid-cols-2">
              {fields.map(([k, v]) => (
                <Check key={k} name="profileFields" value={k}>
                  <div className="text-xs text-muted">{FIELD_LABELS[k]}</div>
                  <div className="line-clamp-3">{String(v)}</div>
                </Check>
              ))}
            </div>
          </Card>
        )}
        <Card title={`Experience (${d.experiences.length})`}>
          <div className="space-y-2">
            {d.experiences.map((e, i) => (
              <Check key={i} name="experiences" value={i} defaultChecked={!!e.startDate}>
                <div className="font-medium">{e.title} — {e.employer}</div>
                <div className="text-xs text-muted">
                  {e.startDate ?? "no start date"} → {e.isCurrent ? "present" : e.endDate ?? "?"}{e.location ? ` · ${e.location}` : ""}
                </div>
                <div className="mt-1 whitespace-pre-line text-xs text-slate-600 line-clamp-4">{e.description}</div>
              </Check>
            ))}
          </div>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={`Qualifications (${d.qualifications.length})`}>
            <div className="space-y-2">
              {d.qualifications.map((q, i) => (
                <Check key={i} name="qualifications" value={i}>
                  <span className="font-medium">{q.name}</span>
                  {q.issuer && <span className="text-muted"> · {q.issuer}</span>}{" "}
                  <Badge tone={q.state === "held" ? "good" : "attention"}>{q.state === "held" ? "Held" : "In progress"}</Badge>
                </Check>
              ))}
            </div>
          </Card>
          <Card title={`Skills (${d.skills.length})`}>
            <div className="flex flex-wrap gap-2">
              {d.skills.map((s) => (
                <label key={s} className="flex items-center gap-1.5 rounded-full border border-line bg-slate-50 px-3 py-1 text-sm">
                  <input type="checkbox" name="skills" value={s} defaultChecked className="accent-brand-600" /> {s}
                </label>
              ))}
            </div>
          </Card>
        </div>
        {d.highlights.length > 0 && (
          <Card title={`Achievements with numbers (${d.highlights.length})`} description="These are added as drafts. You'll confirm what each number means before any CV uses it.">
            <div className="space-y-2">
              {d.highlights.map((h, i) => (
                <Check key={i} name="highlights" value={i}>{h.statement}</Check>
              ))}
            </div>
          </Card>
        )}
        <div className="flex items-center gap-3">
          <SubmitButton pendingText="Adding…">Add to my profile</SubmitButton>
          <Link href="/profile?tab=highlights" className="text-sm text-brand-600 hover:underline">Then verify highlights →</Link>
        </div>
      </ActionForm>
    </>
  );
}
