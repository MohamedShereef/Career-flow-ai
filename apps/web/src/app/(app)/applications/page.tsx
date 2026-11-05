import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { applications, jobs } from "@careerflow/db";
import { gmail } from "@careerflow/core";
import { Badge, Card, EmptyState, PageHeader, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Applications" };

const LABEL: Record<string, [string, "neutral" | "brand" | "good" | "attention" | "bad"]> = {
  discovered: ["Discovered", "neutral"],
  matched: ["Matched", "brand"],
  prepared: ["Prepared", "brand"],
  awaiting_approval: ["Waiting for your approval", "attention"],
  processing: ["Processing", "brand"],
  needs_user_action: ["Needs you", "attention"],
  submitted_unverified: ["Submitted · unverified", "neutral"],
  confirmed_by_email: ["Confirmed by email", "good"],
  interview: ["Interview", "good"],
  rejected: ["Rejected", "bad"],
  closed: ["Closed", "neutral"],
  failed: ["Failed", "bad"],
  withdrawn: ["Cancelled", "neutral"],
};

export default async function Applications({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const { status } = await searchParams;
  const rows = await db()
    .select({ a: applications, title: jobs.title, company: jobs.companyName })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(eq(applications.userId, user.id))
    .orderBy(desc(applications.updatedAt))
    .limit(200);
  const filtered = status ? rows.filter((r) => r.a.status === status) : rows;
  const [mail, emails] = await Promise.all([gmail.status(db(), user.id), gmail.recentJobEmails(db(), user.id, 30)]);
  const CLASS: Record<string, [string, "neutral" | "brand" | "good" | "attention" | "bad"]> = {
    application_receipt: ["Receipt", "good"],
    interview_invitation: ["Interview", "attention"],
    assessment: ["Assessment", "attention"],
    rejection: ["Not progressing", "bad"],
    offer: ["Offer", "good"],
    recruiter_outreach: ["Recruiter", "brand"],
    status_update: ["Update", "neutral"],
  };

  return (
    <>
      <PageHeader title="Applications" subtitle="Every application with its evidence and full execution history." />
      {emails.some((x) => x.e.actionNeeded && ["interview_invitation", "assessment", "offer"].includes(x.e.classification)) && (
        <div className="mb-6 rounded-xl border border-attention/30 bg-attention-50 p-4 text-sm">
          <strong>Waiting for your reply:</strong>
          <ul className="mt-1 list-disc pl-5">
            {emails.filter((x) => x.e.actionNeeded && ["interview_invitation", "assessment", "offer"].includes(x.e.classification)).slice(0, 5).map((x) => (
              <li key={x.e.id}>{x.company ?? x.e.employerName ?? x.e.fromDomain}: {x.e.summary}</li>
            ))}
          </ul>
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState title={status ? "No applications with this status" : "No applications yet"}>
          Applications appear here once the agent starts preparing them. A submission only counts as confirmed when an employer email proves it.
        </EmptyState>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-muted">
              <tr><th className="px-4 py-2">Role</th><th className="px-4 py-2">Employer</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Updated</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map(({ a, title, company }) => {
                const [label, tone] = LABEL[a.status] ?? [a.status, "neutral"];
                return (
                  <tr key={a.id}>
                    <td className="px-4 py-3 font-medium"><Link href={`/applications/${a.id}`} className="text-brand-700 hover:underline">{title}</Link>{a.statusReason && <div className="mt-0.5 line-clamp-2 text-xs font-normal text-muted">{a.statusReason}</div>}</td>
                    <td className="px-4 py-3">{company}</td>
                    <td className="px-4 py-3"><Badge tone={tone}>{label}</Badge></td>
                    <td className="px-4 py-3 text-muted">{fmtDate(a.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-8">
        <Card title="Job emails" description={mail ? `From ${mail.email}. Receipts confirm applications automatically; interviews, tests and replies show here.` : undefined}>
          {!mail ? (
            <p className="text-sm text-muted">Connect Gmail in <Link href="/settings?tab=integrations" className="text-brand-600 hover:underline">Settings → Integrations</Link> to confirm receipts and catch interview invitations automatically.</p>
          ) : emails.length === 0 ? (
            <p className="text-sm text-muted">No job-related emails yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {emails.map(({ e, company, title }) => {
                const [label, tone] = CLASS[e.classification] ?? [e.classification, "neutral"];
                return (
                  <li key={e.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={tone}>{label}</Badge>
                      <span className="font-medium">{company ?? e.employerName ?? e.fromDomain}</span>
                      {(title ?? e.jobTitle) && <span className="text-muted">· {title ?? e.jobTitle}</span>}
                      <span className="ml-auto text-xs text-muted">{e.receivedAt ? fmtDate(e.receivedAt) : ""}</span>
                    </div>
                    <div className="mt-1 text-slate-700">{e.summary}</div>
                    {e.proposedTimes && e.proposedTimes.length > 0 && <div className="mt-1 text-xs text-attention">Times mentioned: {e.proposedTimes.map((t) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" })).join(" · ")}</div>}
                    {e.matchedApplicationId ? <Link href={`/applications/${e.matchedApplicationId}`} className="text-xs text-brand-600 hover:underline">Open application →</Link> : <span className="text-xs text-muted">{e.matchStatus === "ambiguous" ? "Matches more than one application" : "Not linked to an application in CareerFlow"}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
