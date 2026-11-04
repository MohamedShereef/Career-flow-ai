import Link from "next/link";
import { ai, matching, tailor } from "@careerflow/core";
import { tailorAction } from "@/actions/cv";
import { reindexAction, runDiscoveryAction } from "@/actions/jobs";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, PageHeader, TextArea, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Jobs" };

const TABS = [
  ["recommended", "Recommended"],
  ["needs_review", "Needs your review"],
  ["rejected", "Rejected"],
  ["tailor", "Tailor for any job"],
] as const;

const scoreTone = (s: number) => (s >= 75 ? "good" : s >= 50 ? "brand" : "neutral");

export default async function Jobs({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = (TABS.some(([k]) => k === sp.tab) ? sp.tab : "recommended") as (typeof TABS)[number][0];
  const [counts, aiReady] = await Promise.all([matching.matchCounts(db(), user.id), Promise.resolve(ai.aiConfigured())]);
  const rows = tab === "tailor" ? [] : await matching.listMatches(db(), user.id, tab);
  const tailored = tab === "tailor" ? await tailor.listTailorings(db(), user.id) : [];

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Found on employers' official job boards, vetted, and scored against your profile. New searches run automatically every 6 hours."
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionForm action={runDiscoveryAction}><SubmitButton className="btn-primary" pendingText="Starting…">Find new jobs now</SubmitButton></ActionForm>
            <ActionForm action={reindexAction}><SubmitButton className="btn-secondary" pendingText="Starting…">Re-evaluate all</SubmitButton></ActionForm>
          </div>
        }
      />
      {!aiReady && <p className="mb-4 rounded-lg bg-attention-50 p-3 text-sm text-attention">The AI engine isn't connected, so jobs are collected but not scored yet.</p>}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/jobs?tab=${k}`} className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-muted hover:text-ink"}`}>
            {label}
            {k !== "tailor" && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{counts[k as keyof typeof counts]}</span>}
          </Link>
        ))}
      </div>

      {tab === "tailor" ? (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Card title="Tailor my CV for a job" description="For jobs you found yourself (LinkedIn, referrals). Paste the description; you get an ATS-friendly CV and cover letter from your verified profile.">
              {!aiReady ? (
                <p className="text-sm text-attention">Needs the AI engine.</p>
              ) : (
                <ActionForm action={tailorAction} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Job title" name="jobTitle" required />
                    <Field label="Company" name="companyName" required />
                  </div>
                  <TextArea label="Job description" name="jobDescription" required rows={10} />
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="includeCoverLetter" defaultChecked className="accent-brand-600" /> Also write a cover letter</label>
                  <SubmitButton pendingText="Tailoring… (about a minute)">Create tailored CV</SubmitButton>
                </ActionForm>
              )}
            </Card>
          </div>
          <div className="lg:col-span-2">
            <Card title="Tailored CVs">
              {tailored.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
                <ul className="divide-y divide-line">
                  {tailored.map((t) => (
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
      ) : rows.length === 0 ? (
        <EmptyState title={tab === "recommended" ? "No recommended jobs yet" : "Nothing here"}>
          {tab === "recommended" ? (
            <>Press “Find new jobs now”, or wait for the next automatic search. Make sure your target titles are set in <Link href="/profile?tab=preferences" className="text-brand-600 underline">Job preferences</Link>. You can add more employers' job boards in <Link href="/settings?tab=sources" className="text-brand-600 underline">Settings → Job sources</Link>.</>
          ) : null}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {rows.map(({ e, j }) => (
            <Link key={j.id} href={`/jobs/${j.id}`} className="card block p-4 transition hover:border-slate-300">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold">{j.title}</div>
                  <div className="text-sm text-muted">{j.companyName}{j.location ? ` · ${j.location}` : ""}</div>
                </div>
                <Badge tone={e.decision === "rejected" ? "neutral" : scoreTone(e.score)}>{e.method === "rule" ? "Rule" : `${e.score}%`}</Badge>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-700">{e.summary}</p>
              {e.rejectionReasons.length > 0 && <p className="mt-1 text-xs text-bad">{e.rejectionReasons.join(" · ")}</p>}
              <div className="mt-2 text-xs text-muted">First seen {fmtDate(j.firstSeenAt)}{j.postedAt ? ` · posted ${fmtDate(j.postedAt)}` : ""}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
