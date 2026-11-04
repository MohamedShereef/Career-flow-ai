import Link from "next/link";
import { auth, dashboard, settings } from "@careerflow/core";
import { changePasswordAction, signOutOtherSessionsAction } from "@/actions/auth";
import { consentAction, saveAutomationAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Field, PageHeader, Select, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Settings" };

const TABS = [["automation", "Automation & limits"], ["consent", "Consent"], ["integrations", "Integrations"], ["security", "Security"], ["diagnostics", "Diagnostics"]] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "automation";
  const s = await settings.getSettings(db(), user.id);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/settings?tab=${key}`} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-brand-600 text-brand-700" : "border-transparent text-muted hover:text-ink"}`}>
            {label}
          </Link>
        ))}
      </div>

      {tab === "automation" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Pilot limits" description="Supervised mode. The first applications always need your approval; continuous submission stays off until the pilot proves reliable.">
            <ActionForm action={saveAutomationAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Final submissions per day" name="maxSubmissionsPerDay" type="number" min={0} max={settings.PILOT_LIMITS.maxSubmissionsPerDay} defaultValue={s.maxSubmissionsPerDay} hint={`Pilot maximum: ${settings.PILOT_LIMITS.maxSubmissionsPerDay}`} />
                <Field label="Form inspections per day" name="maxInspectionsPerDay" type="number" min={0} max={settings.PILOT_LIMITS.maxInspectionsPerDay} defaultValue={s.maxInspectionsPerDay} hint={`Pilot maximum: ${settings.PILOT_LIMITS.maxInspectionsPerDay}`} />
                <Field label="Jobs per batch" name="maxBatchSize" type="number" min={1} max={settings.PILOT_LIMITS.maxBatchSize} defaultValue={s.maxBatchSize} />
                <Field label="Match threshold (%)" name="matchThreshold" type="number" min={0} max={100} defaultValue={s.matchThreshold} hint="Jobs scoring below this are not recommended." />
                <Field label="Discover new jobs every (hours)" name="discoveryIntervalHours" type="number" min={1} max={168} defaultValue={s.discoveryIntervalHours} />
                <Select label="Time zone" name="timezone" defaultValue={s.timezone} options={[["Asia/Riyadh", "Riyadh (UTC+3)"], ["Asia/Dubai", "Dubai (UTC+4)"], ["Africa/Cairo", "Cairo"], ["UTC", "UTC"]]} />
              </div>
              <SubmitButton>Save limits</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Autopilot">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span>Manual approval required for first</span><Badge>{s.manualApprovalUntilCount} applications</Badge></div>
              <div className="flex justify-between"><span>Continuous submission</span><Badge tone={s.continuousSubmissionEnabled ? "good" : "neutral"}>{s.continuousSubmissionEnabled ? "On" : "Off"}</Badge></div>
              <p className="text-muted">Autopilot unlocks after {s.manualApprovalUntilCount} approved applications have been submitted with captured evidence. Legal declarations and identity questions always come to you.</p>
            </div>
          </Card>
        </div>
      )}

      {tab === "consent" && (
        <Card title="What the agent may do on your behalf" description="You can withdraw any consent at any time. Every change is recorded in the audit log.">
          <ul className="divide-y divide-line">
            {([
              ["automation", "Fill and submit applications on employer sites after your approval", s.automationConsentAt],
              ["email_tracking", "Read application-related emails in Gmail to confirm receipts and track replies", s.emailTrackingConsentAt],
              ["outreach", "Email verified recruiter addresses on your behalf (each message still needs your approval)", s.outreachConsentAt],
            ] as const).map(([kind, text, at]) => (
              <li key={kind} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <div className="text-sm">{text}</div>
                  <div className="text-xs text-muted">{at ? `Granted ${fmtDate(at)}` : "Not granted"}</div>
                </div>
                <form action={consentAction}>
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="granted" value={at ? "0" : "1"} />
                  <button className={at ? "btn-secondary" : "btn-primary"}>{at ? "Withdraw" : "Allow"}</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "integrations" && <Integrations />}
      {tab === "security" && <Security userId={user.id} />}
      {tab === "diagnostics" && <Diagnostics />}
    </>
  );
}

async function Integrations() {
  const aiConfigured = !!process.env.OPENAI_API_KEY;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="AI engine (OpenAI)">
        <div className="flex items-center justify-between text-sm">
          <span>Model: {process.env.OPENAI_MODEL ?? "gpt-5-mini"}</span>
          <Badge tone={aiConfigured ? "good" : "attention"}>{aiConfigured ? "Key configured" : "No API key"}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted">The key is set as a server environment variable and is never sent to the browser. It powers CV reading and tailoring now, and job matching next.</p>
      </Card>
      <Card title="Gmail">
        <div className="flex items-center justify-between text-sm"><span>Read-only access to confirm employer receipts</span><Badge>Coming soon</Badge></div>
      </Card>
    </div>
  );
}

async function Security({ userId }: { userId: string }) {
  const sessions = await auth.listSessions(db(), userId);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Change password">
        <ActionForm action={changePasswordAction} className="space-y-3" resetOnSuccess>
          <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
          <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          <SubmitButton>Change password</SubmitButton>
        </ActionForm>
      </Card>
      <Card title="Active sessions">
        <ul className="mb-4 divide-y divide-line text-sm">
          {sessions.map((s) => (
            <li key={s.id} className="py-2">
              <div className="truncate">{s.userAgent ?? "Unknown device"}</div>
              <div className="text-xs text-muted">Signed in {fmtDate(s.createdAt)} · last active {fmtDate(s.lastSeenAt)}</div>
            </li>
          ))}
        </ul>
        <ActionForm action={signOutOtherSessionsAction}><SubmitButton className="btn-secondary">Sign out other devices</SubmitButton></ActionForm>
      </Card>
    </div>
  );
}

async function Diagnostics() {
  const h = await dashboard.systemHealth(db());
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Services">
        <ul className="space-y-2 text-sm">
          <li className="flex justify-between"><span>Database</span><Badge tone="good">OK · {h.database.latencyMs} ms</Badge></li>
          <li className="flex justify-between"><span>AI key</span><Badge tone={h.ai.configured ? "good" : "attention"}>{h.ai.configured ? "Configured" : "Missing"}</Badge></li>
          <li className="flex justify-between"><span>Queued tasks</span><Badge>{h.queue.queued}</Badge></li>
          <li className="flex justify-between"><span>Running tasks</span><Badge>{h.queue.running}</Badge></li>
          <li className="flex justify-between"><span>Blocked (need review)</span><Badge tone={h.queue.blocked ? "attention" : "neutral"}>{h.queue.blocked}</Badge></li>
          <li className="flex justify-between"><span>Failed in last 24h</span><Badge tone={h.queue.dead_24h ? "bad" : "neutral"}>{h.queue.dead_24h}</Badge></li>
        </ul>
      </Card>
      <Card title="Workers">
        {h.workers.length === 0 ? (
          <p className="text-sm text-muted">No worker has reported in. Background tasks will wait until the Railway worker is running.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {h.workers.map((w) => (
              <li key={w.workerId} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-mono text-xs">{w.workerId}</div>
                  <div className="text-xs text-muted">{w.kind}{w.version ? ` · ${w.version}` : ""} · seen {fmtDate(w.lastSeenAt)}</div>
                </div>
                <Badge tone={w.online ? "good" : "bad"}>{w.online ? "Online" : "Offline"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
