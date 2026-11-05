import Link from "next/link";
import { notFound } from "next/navigation";
import { employers, matching } from "@careerflow/core";
import { tailorForJobAction, undoNotInterestedAction } from "@/actions/jobs";
import { NotInterested } from "@/components/not-interested";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Job" };

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const m = await matching.getMatch(db(), user.id, id);
  if (!m) notFound();
  const { e, j } = m;
  const emp = await employers.getAssessment(db(), j.companyName);
  const factors = (e?.breakdown as Array<{ factor: string; score: number; explanation: string }> | undefined) ?? [];

  return (
    <>
      <PageHeader
        title={j.title}
        subtitle={<>{j.companyName}{j.location ? ` · ${j.location}` : ""} · first seen {fmtDate(j.firstSeenAt)}{j.status !== "active" ? " · closed" : ""}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={j.sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary">Open original posting ↗</a>
            {j.description && (
              <ActionForm action={tailorForJobAction}>
                <input type="hidden" name="jobId" value={j.id} />
                <SubmitButton pendingText="Tailoring… (about a minute)">Tailor CV for this job</SubmitButton>
              </ActionForm>
            )}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {e?.rejectionReasons?.some((r) => r.startsWith("Your decision")) ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-slate-50 p-3 text-sm">
              <span>{e.summary} CareerFlow uses this to score similar jobs.</span>
              <form action={undoNotInterestedAction}><input type="hidden" name="jobId" value={j.id} /><button className="btn-ghost">Undo</button></form>
            </div>
          ) : (
            <div className="rounded-xl border border-line p-3"><NotInterested jobId={j.id} /></div>
          )}
          <Card title="Match" actions={e && <Badge tone={e.decision === "recommended" ? "good" : e.decision === "needs_review" ? "attention" : "neutral"}>{e.decision === "recommended" ? "Recommended" : e.decision === "needs_review" ? "Needs your review" : "Rejected"}</Badge>}>
            {!e ? (
              <p className="text-sm text-muted">Not evaluated yet.</p>
            ) : (
              <>
                <div className="flex items-baseline gap-3">
                  <div className="text-4xl font-semibold tabular-nums">{e.method === "rule" ? "—" : `${e.score}%`}</div>
                  <div className="text-xs text-muted">{e.method === "ai" ? "Scored by AI on the full description" : "Decided by a rule (no AI used)"}</div>
                </div>
                <p className="mt-3 text-sm">{e.summary}</p>
                {e.rejectionReasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-bad">{e.rejectionReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                {factors.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {factors.map((f, i) => (
                      <div key={i}>
                        <div className="flex justify-between text-sm"><span className="font-medium">{f.factor}</span><span className="tabular-nums text-muted">{Math.round(f.score)}</span></div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(0, Math.min(100, f.score))}%` }} /></div>
                        <div className="mt-1 text-xs text-muted">{f.explanation}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
          <Card title="Job description">
            {j.description ? <div className="whitespace-pre-line text-sm text-slate-700">{j.description}</div> : <p className="text-sm text-muted">The job board didn't provide a description. Open the original posting.</p>}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Employer check">
            {!emp ? (
              <p className="text-sm text-muted">Not assessed yet.</p>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="brand">{employers.EMPLOYER_TYPE_LABEL[emp.employerType] ?? emp.employerType}</Badge>
                  <Badge>{emp.scale === "unknown" ? "Size unknown" : `${emp.scale} company`}</Badge>
                  {emp.pifAffiliated === "yes" && <Badge tone="good">PIF company</Badge>}
                </div>
                {emp.summary && <p className="text-slate-700">{emp.summary}</p>}
                {emp.redFlags.length > 0 && <ul className="list-disc pl-5 text-bad">{emp.redFlags.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                <p className="text-xs text-muted">{emp.method === "ai" ? `AI assessment, confidence ${Math.round(Number(emp.confidence ?? 0) * 100)}%` : "From the curated list"} · {fmtDate(emp.assessedAt)}</p>
                <p className="text-xs text-muted">Always/never apply to a company: <Link className="text-brand-600 underline" href="/profile?tab=preferences">Job preferences</Link></p>
              </div>
            )}
          </Card>
          <Card title="Posting">
            <ul className="space-y-1 text-sm">
              <li><span className="text-muted">Source:</span> {j.atsKind}</li>
              {j.employmentType && <li><span className="text-muted">Type:</span> {j.employmentType}</li>}
              {j.postedAt && <li><span className="text-muted">Posted:</span> {fmtDate(j.postedAt)}</li>}
              <li><span className="text-muted">Last seen:</span> {fmtDate(j.lastSeenAt)}</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
