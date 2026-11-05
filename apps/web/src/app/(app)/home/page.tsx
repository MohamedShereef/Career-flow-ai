import Link from "next/link";
import { ai, answers, dashboard, profile } from "@careerflow/core";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Home" };

/** Capabilities ship in stages; this list is honest about what is live. */
function capabilities(aiReady: boolean): Array<{ name: string; live: boolean; note: string }> {
  const needsAi = aiReady ? "Ready" : "Needs AI key";
  return [
    { name: "Profile, verified facts & saved answers", live: true, note: "Ready" },
    { name: "Fill profile from your CV", live: aiReady, note: needsAi },
    { name: "Tailored CV & cover letters", live: aiReady, note: needsAi },
    { name: "Job discovery, employer vetting & matching", live: aiReady, note: aiReady ? "Ready" : "Needs AI key" },
    { name: "Auto-apply on employer sites (you approve each)", live: aiReady, note: aiReady ? "Ready" : "Needs AI key" },
    { name: "Gmail tracking (receipts, interviews, replies)", live: aiReady, note: aiReady ? "Connect in Settings" : "Needs AI key" },
    { name: "Interview scheduling replies", live: false, note: "Next release" },
  ];
}

export default async function Home() {
  const user = await requireUser();
  const [stats, completeness, health, questions] = await Promise.all([
    dashboard.homeStats(db(), user.id),
    profile.profileCompleteness(db(), user.id),
    dashboard.systemHealth(db()),
    answers.listPendingQuestions(db(), user.id),
  ]);
  const firstName = (user.displayName ?? "").split(" ")[0];

  return (
    <>
      <PageHeader title={firstName ? `Welcome, ${firstName}` : "Welcome"} subtitle="Everything below is live from your account — no sample data." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Confirmed by employer email" value={stats.confirmedByEmail} tone="good" href="/applications?status=confirmed_by_email" />
        <Stat label="Submitted, awaiting confirmation" value={stats.submittedAwaitingConfirmation} href="/applications?status=submitted_unverified" />
        <Stat label="Awaiting your approval" value={stats.awaitingApproval} tone={stats.awaitingApproval ? "attention" : "neutral"} href="/applications?status=awaiting_approval" />
        <Stat label="Questions waiting for you" value={stats.openQuestions} tone={stats.openQuestions ? "attention" : "neutral"} href="/profile?tab=questions" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {completeness.percent < 100 && (
            <Card title="Finish your profile" description="The agent only uses facts you've entered and verified. Missing items limit what it can apply for.">
              <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${completeness.percent}%` }} />
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {completeness.checks.map((c) => (
                  <li key={c.key} className="flex items-center gap-2 text-sm">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${c.ok ? "bg-good-50 text-good" : "bg-slate-100 text-slate-400"}`}>{c.ok ? "✓" : "•"}</span>
                    <span className={c.ok ? "text-muted line-through" : ""}>{c.label}</span>
                  </li>
                ))}
              </ul>
              <Link href="/profile" className="btn-primary mt-4">Continue profile</Link>
            </Card>
          )}

          {questions.length > 0 && (
            <Card title="Questions waiting for your answer" description="Answer once — the agent reuses it everywhere." actions={<Link href="/profile?tab=questions" className="text-sm text-brand-600 hover:underline">Answer all</Link>}>
              <ul className="divide-y divide-line">
                {questions.slice(0, 4).map((q) => (
                  <li key={q.id} className="py-2 text-sm">
                    <div className="font-medium">“{q.questionText}”</div>
                    <div className="text-xs text-muted">{[q.employerName, q.jobTitle].filter(Boolean).join(" · ") || "General"}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Problems by root cause" description="Grouped so one fix clears many applications.">
            {stats.problems.length ? (
              <ul className="divide-y divide-line">
                {stats.problems.map((p) => (
                  <li key={p.rootCauseKey} className="flex items-center justify-between py-2 text-sm">
                    <span>{p.message}</span>
                    <Badge tone="bad">{p.n}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No open problems.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Agent capabilities">
            <ul className="space-y-2">
              {capabilities(ai.aiConfigured()).map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-2 text-sm">
                  <span>{c.name}</span>
                  <Badge tone={c.live ? "good" : "neutral"}>{c.note}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="System health" actions={<Link href="/settings?tab=diagnostics" className="text-sm text-brand-600 hover:underline">Details</Link>}>
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between"><span>Database</span><Badge tone="good">{health.database.latencyMs} ms</Badge></li>
              <li className="flex justify-between"><span>Background worker</span><Badge tone={health.workerOnline ? "good" : "attention"}>{health.workerOnline ? "Online" : "Offline"}</Badge></li>
              <li className="flex justify-between"><span>AI connection</span><Badge tone={health.ai.state === "working" ? "good" : health.ai.state === "untested" ? "neutral" : "bad"}>{{ working: "Working", untested: "Key set (untested)", missing: "No key", rejected: "Key rejected by OpenAI", no_credit: "No credit / rate-limited" }[health.ai.state]}</Badge></li>
              <li className="flex justify-between"><span>Tasks needing review</span><Badge tone={health.queue.blocked ? "attention" : "neutral"}>{health.queue.blocked}</Badge></li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
