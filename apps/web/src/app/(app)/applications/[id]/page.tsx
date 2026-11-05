import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, autoapply } from "@careerflow/core";
import { approveApplicationAction, cancelApplicationAction, resolveUncertainAction, retryApplicationAction } from "@/actions/applications";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Application" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, [string, "neutral" | "brand" | "good" | "attention" | "bad"]> = {
  prepared: ["Prepared", "brand"],
  processing: ["Working on it", "brand"],
  awaiting_approval: ["Waiting for your approval", "attention"],
  needs_user_action: ["Needs you", "attention"],
  submitted_unverified: ["Submitted", "good"],
  confirmed_by_email: ["Confirmed by email", "good"],
  interview: ["Interview", "good"],
  rejected: ["Rejected", "bad"],
  withdrawn: ["Cancelled", "neutral"],
  failed: ["Failed", "bad"],
  closed: ["Closed", "neutral"],
};

const SOURCE: Record<string, [string, "neutral" | "brand" | "good" | "attention"]> = {
  profile: ["From your profile", "neutral"],
  saved_answer: ["Your saved answer", "good"],
  document: ["Your approved CV", "good"],
  ai: ["Written by AI — check it", "attention"],
};

function show(v: autoapply.AnswerValue) {
  if (v.kind === "file") return v.doc === "cv" ? "Tailored CV (PDF)" : "Cover letter (PDF)";
  if (v.kind === "bool") return v.value ? "Yes (ticked)" : "No";
  if (v.kind === "multi") return v.values.join(", ");
  return v.value;
}

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let d;
  try {
    d = await autoapply.getDetail(db(), user.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const { app, job, preview } = d;
  const [label, tone] = STATUS[app.status] ?? [app.status, "neutral"];
  const working = app.status === "processing";
  const uncertain = app.checkpoint === "uncertain";
  const canRetry = app.status === "needs_user_action" && !uncertain && d.questions.length === 0;

  return (
    <>
      {working && <meta httpEquiv="refresh" content="20" />}
      <PageHeader
        title={`${job.title} · ${job.companyName}`}
        subtitle={<>Started {fmtDate(app.createdAt)} · <a className="text-brand-600 hover:underline" href={job.applyUrl} target="_blank" rel="noopener">Employer's page ↗</a></>}
        actions={<Link href="/applications" className="btn-secondary">All applications</Link>}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={tone}>{label}</Badge>
        {app.statusReason && <span className="text-sm text-slate-700">{app.statusReason}</span>}
        {working && <span className="text-xs text-muted">This page refreshes by itself.</span>}
      </div>

      {d.questions.length > 0 && (
        <div className="mb-6 rounded-xl border border-attention/30 bg-attention-50 p-4 text-sm">
          <strong>{d.questions.length} question{d.questions.length > 1 ? "s" : ""} for you:</strong>
          <ul className="mt-1 list-disc pl-5">{d.questions.map((q) => <li key={q.id}>{q.questionText}</li>)}</ul>
          <Link href="/profile?tab=questions" className="mt-2 inline-block font-medium text-brand-700 hover:underline">Answer them → the application continues by itself</Link>
        </div>
      )}

      {uncertain && (
        <Card title="Did it go through?" description="We pressed Submit but the page didn't clearly confirm it. Check your email for a receipt from the employer.">
          <div className="flex flex-wrap gap-3">
            <ActionForm action={resolveUncertainAction}><input type="hidden" name="applicationId" value={app.id} /><input type="hidden" name="wentThrough" value="1" /><SubmitButton>Yes, I got a confirmation</SubmitButton></ActionForm>
            <ActionForm action={resolveUncertainAction}><input type="hidden" name="applicationId" value={app.id} /><input type="hidden" name="wentThrough" value="0" /><SubmitButton className="btn-secondary">No, it wasn't sent</SubmitButton></ActionForm>
          </div>
        </Card>
      )}

      {app.status === "awaiting_approval" && preview && (
        <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50 p-4">
          <p className="text-sm text-brand-700">
            Check the answers and the filled form below. When you approve, CareerFlow re-opens the employer's page, fills exactly these answers, and presses Submit once.
            If anything on their form changed, it stops and asks you again.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <ActionForm action={approveApplicationAction}><input type="hidden" name="previewId" value={preview.id} /><SubmitButton pendingText="Approving…">Approve & submit</SubmitButton></ActionForm>
            <ActionForm action={cancelApplicationAction}><input type="hidden" name="applicationId" value={app.id} /><SubmitButton className="btn-secondary" pendingText="Cancelling…">Don't apply</SubmitButton></ActionForm>
          </div>
        </div>
      )}

      {canRetry && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <a className="btn-primary" href={job.applyUrl} target="_blank" rel="noopener">Open the employer's page ↗</a>
          {app.tailoredCvDocumentId && <a className="btn-secondary" href={`/api/documents/${app.tailoredCvDocumentId}`} target="_blank">Download the CV</a>}
          <ActionForm action={retryApplicationAction}><input type="hidden" name="applicationId" value={app.id} /><SubmitButton className="btn-secondary" pendingText="Starting…">Try automatic again</SubmitButton></ActionForm>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {preview && (
            <Card title={`What will be sent (version ${preview.version})`} description={preview.data.skippedOptional ? `${preview.data.skippedOptional} optional field(s) left empty.` : undefined}>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line">
                  {preview.data.answers.map((a) => {
                    const [s, t] = SOURCE[a.source] ?? [a.source, "neutral"];
                    return (
                      <tr key={a.key} className="align-top">
                        <td className="w-2/5 py-2 pr-3 text-muted">{a.label}</td>
                        <td className="py-2">
                          <div className="whitespace-pre-line">{show(a.value)}</div>
                          <Badge tone={t}>{s}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          {preview?.screenshotDocumentId && (
            <Card title="The employer's form, filled (before submit)">
              <a href={`/api/documents/${preview.screenshotDocumentId}`} target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/documents/${preview.screenshotDocumentId}`} alt="Filled application form" className="w-full rounded-lg border border-line" />
              </a>
            </Card>
          )}
        </div>
        <div className="space-y-6 lg:col-span-2">
          {d.evidence.length > 0 && (
            <Card title="Evidence">
              <ul className="space-y-2 text-sm">
                {d.evidence.map((e) => (
                  <li key={e.id}>
                    <Badge tone={e.level === "email" ? "good" : "brand"}>{e.level === "email" ? "Email" : "Website"}</Badge> {e.summary}
                    {e.documentId && <> · <a className="text-brand-600 hover:underline" href={`/api/documents/${e.documentId}`} target="_blank">screenshot</a></>}
                    <div className="text-xs text-muted">{fmtDate(e.capturedAt)}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="History">
            <ol className="space-y-3 text-sm">
              {d.events.map((e) => (
                <li key={e.id} className="border-l-2 border-line pl-3">
                  <div className={e.kind === "error" ? "text-bad" : ""}>{e.message}</div>
                  <div className="text-xs text-muted">{fmtDate(e.createdAt)}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
