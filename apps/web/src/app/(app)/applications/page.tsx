import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { applications, jobs } from "@careerflow/db";
import { Badge, EmptyState, PageHeader, fmtDate } from "@/components/ui";
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

  return (
    <>
      <PageHeader title="Applications" subtitle="Every application with its evidence and full execution history." />
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
    </>
  );
}
