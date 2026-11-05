import Link from "next/link";
import { SOURCE_HELP, auth, autoapply, dashboard, discovery, gmail, logins, settings } from "@careerflow/core";
import { changePasswordAction, signOutOtherSessionsAction } from "@/actions/auth";
import { autopilotAction, connectGmailAction, deleteLoginAction, disconnectGmailAction, saveAvailabilityAction, saveLoginAction, syncGmailAction } from "@/actions/applications";
import { consentAction, saveAutomationAction } from "@/actions/profile";
import { addSourceAction, toggleSourceAction } from "@/actions/jobs";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, EmptyState, Field, PageHeader, Select, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Settings" };

const TABS = [["automation", "Automation & limits"], ["sources", "Job sources"], ["logins", "Saved logins"], ["consent", "Consent"], ["integrations", "Integrations"], ["security", "Security"], ["diagnostics", "Diagnostics"]] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "automation";
  const [s, pilot] = await Promise.all([settings.getSettings(db(), user.id), autoapply.autopilotStatus(db(), user.id)]);

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
          <Card title="Daily limits" description="Hard ceilings the agent never exceeds, even on autopilot. They reset at midnight in your time zone.">
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
          <Card title="Interview availability" description="Used word for word when an employer asks when you're free. Replies are always shown to you before sending.">
            <ActionForm action={saveAvailabilityAction} className="space-y-3">
              <Field label="When can you usually interview?" name="availability" defaultValue={s.interviewAvailability ?? ""} placeholder="Sunday–Thursday after 4 pm, Riyadh time; Saturdays any time" />
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Autopilot" description="Works on its own between your visits: picks your best new matches, tailors the CV and fills the employer's form.">
            <div className="space-y-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium">Prepare applications for me</div>
                  <div className="text-muted">Every hour, up to {s.maxBatchSize} of your recommended jobs at a time. You approve each one before it's sent.</div>
                </div>
                <ActionForm action={autopilotAction}>
                  <input type="hidden" name="field" value="prepare" />
                  <input type="hidden" name="on" value={s.autopilotEnabled ? "0" : "1"} />
                  <SubmitButton className={s.autopilotEnabled ? "btn-secondary" : "btn-primary"}>{s.autopilotEnabled ? "Turn off" : "Turn on"}</SubmitButton>
                </ActionForm>
              </div>
              <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
                <div>
                  <div className="font-medium">Submit without asking</div>
                  <div className="text-muted">
                    {pilot.unlocked
                      ? "Only when every answer came from your profile, saved answers or approved CV. Anything written by AI, legal or identity questions still come to you."
                      : `Unlocks after ${pilot.needed} applications you approved were sent (${pilot.approvedSubmitted} so far).`}
                  </div>
                </div>
                {pilot.unlocked ? (
                  <ActionForm action={autopilotAction}>
                    <input type="hidden" name="field" value="autoSubmit" />
                    <input type="hidden" name="on" value={s.continuousSubmissionEnabled ? "0" : "1"} />
                    <SubmitButton className={s.continuousSubmissionEnabled ? "btn-secondary" : "btn-primary"}>{s.continuousSubmissionEnabled ? "Turn off" : "Turn on"}</SubmitButton>
                  </ActionForm>
                ) : (
                  <Badge>{pilot.approvedSubmitted}/{pilot.needed}</Badge>
                )}
              </div>
              {!s.automationConsentAt && <p className="text-attention">Needs “Fill and submit applications” allowed in the Consent tab.</p>}
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

      {tab === "sources" && <Sources />}
      {tab === "logins" && <SavedLogins userId={user.id} />}
      {tab === "integrations" && <Integrations userId={user.id} />}
      {tab === "security" && <Security userId={user.id} />}
      {tab === "diagnostics" && <Diagnostics />}
    </>
  );
}

async function SavedLogins({ userId }: { userId: string }) {
  const rows = await logins.listLogins(db(), userId);
  const RESULT: Record<string, [string, "good" | "bad" | "attention"]> = { ok: ["Signed in OK", "good"], failed: ["Sign-in failed", "bad"], verification_required: ["Needs verification", "attention"] };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Employer portals" description="Workday, SuccessFactors and similar portals need an account per employer. Create the account there yourself once; CareerFlow then signs in with it to fill applications — only on that exact site.">
        {rows.length === 0 ? (
          <EmptyState title="No saved logins">Add one when an application asks for it, or below.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.label || r.host}</div>
                  <div className="truncate text-xs text-muted">{r.host} · {r.username}{r.lastUsedAt ? ` · used ${fmtDate(r.lastUsedAt)}` : ""}</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.lastResult && RESULT[r.lastResult] && <Badge tone={RESULT[r.lastResult]![1]}>{RESULT[r.lastResult]![0]}</Badge>}
                  <form action={deleteLoginAction}><input type="hidden" name="id" value={r.id} /><button className="btn-danger">Remove</button></form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Add a portal login" description="Use a password unique to these portals — never your Gmail or bank password. Stored encrypted; never shown again.">
        <ActionForm action={saveLoginAction} className="space-y-4">
          <Field label="Portal link" name="url" placeholder="https://kbr.wd5.myworkdayjobs.com/KBR_Careers" required />
          <Field label="Name (optional)" name="label" placeholder="KBR careers" />
          <Field label="Email or username on that portal" name="username" autoComplete="off" required />
          <Field label="Password on that portal" name="password" type="password" autoComplete="new-password" required />
          <SubmitButton>Save login</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}

async function Integrations({ userId }: { userId: string }) {
  const aiConfigured = !!process.env.OPENAI_API_KEY;
  const g = await gmail.status(db(), userId);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="AI engine (OpenAI)">
        <div className="flex items-center justify-between text-sm">
          <span>Model: {process.env.OPENAI_MODEL ?? "gpt-5-mini"}</span>
          <Badge tone={aiConfigured ? "good" : "attention"}>{aiConfigured ? "Key configured" : "No API key"}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted">The key is set as a server environment variable and is never sent to the browser. It powers CV reading, tailoring, job matching, form answers and email reading.</p>
      </Card>
      <Card title="Gmail" description="Reads only job-related emails (from employers you applied to, application systems, or with interview/application subjects), to confirm receipts and catch interviews, tests and replies. Only a one-line summary is kept — never the email itself.">
        {g ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate">{g.email}</span>
              <Badge tone={g.status === "connected" ? "good" : "bad"}>{g.status === "connected" ? "Connected" : g.status === "revoked" ? "App password rejected" : "Error"}</Badge>
            </div>
            <div className="text-muted">{g.lastSyncAt ? `Last checked ${fmtDate(g.lastSyncAt)}` : "First check in progress…"} · checks every 15 minutes</div>
            {g.lastError && <p className="text-bad">{g.lastError}</p>}
            <div className="flex flex-wrap gap-2">
              <ActionForm action={syncGmailAction}><SubmitButton className="btn-secondary" pendingText="Starting…">Check now</SubmitButton></ActionForm>
              <form action={disconnectGmailAction}><button className="btn-danger">Disconnect</button></form>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-slate-700">
              <li>Turn on <a className="text-brand-600 hover:underline" href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener">2-Step Verification</a> on your Google account (if it isn't already).</li>
              <li>Open <a className="text-brand-600 hover:underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App passwords</a>, type a name like “CareerFlow”, press Create.</li>
              <li>Copy the 16-letter password Google shows and paste it below. You can revoke it there any time.</li>
            </ol>
            <ActionForm action={connectGmailAction} className="space-y-3">
              <Field label="Gmail address" name="email" type="email" required />
              <Field label="App password (16 letters)" name="appPassword" type="password" autoComplete="off" placeholder="abcd efgh ijkl mnop" required />
              <SubmitButton pendingText="Checking with Google…">Connect Gmail</SubmitButton>
            </ActionForm>
          </div>
        )}
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
          <li className="flex justify-between"><span>Version running</span><Badge>{process.env.APP_VERSION ?? "dev"}</Badge></li>
          <li className="flex justify-between"><span>Database</span><Badge tone="good">OK · {h.database.latencyMs} ms</Badge></li>
          <li className="flex justify-between"><span>AI key</span><Badge tone={h.ai.state === "working" ? "good" : h.ai.state === "untested" ? "neutral" : "bad"}>{h.ai.state}</Badge></li>
          {h.ai.lastError && <li className="text-xs text-bad">Last AI error: {h.ai.lastError}</li>}
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

async function Sources() {
  const rows = await discovery.listSources(db());
  const tone = (h: string) => (h === "healthy" ? "good" : h === "degraded" ? "attention" : h === "failing" ? "bad" : "neutral");
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <Card title="Job boards the agent watches" description="Official employer career sites, checked every 6 hours. Only procurement-family roles are kept.">
          {rows.length === 0 ? (
            <EmptyState title="No sources yet">They're added automatically when the worker starts.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map(({ source: s, activeJobs }) => (
                <li key={s.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{s.name} <span className="text-xs font-normal text-muted">· {SOURCE_HELP[s.kind]?.label ?? s.kind}</span></div>
                      <div className="truncate text-xs text-muted">{s.identifier}</div>
                      <div className="mt-1 text-xs text-muted">{activeJobs} open procurement roles · last success {fmtDate(s.lastSuccessAt)}</div>
                      {s.lastError && <div className="mt-1 text-xs text-bad">Last error: {s.lastError}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Badge tone={tone(s.health)}>{s.health}</Badge>
                      <form action={toggleSourceAction}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="enabled" value={s.enabled ? "0" : "1"} />
                        <button className="btn-ghost text-xs">{s.enabled ? "Pause" : "Resume"}</button>
                      </form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="lg:col-span-2">
        <Card title="Add an employer's job board" description="Find the company's careers page, check which system it uses (the address usually shows it), and paste the part shown in the example.">
          <ActionForm action={addSourceAction} className="space-y-3">
            <Select label="System" name="kind" options={Object.entries(SOURCE_HELP).map(([k, v]) => [k, v.label] as [string, string])} />
            <Field label="Company name" name="name" required placeholder="Red Sea Global" />
            <Field label="Address or id" name="identifier" required placeholder="See examples below" />
            <ul className="space-y-1 text-xs text-muted">
              {Object.values(SOURCE_HELP).map((h) => (
                <li key={h.label}><strong>{h.label}:</strong> {h.identifier} — e.g. <code>{h.example}</code></li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button name="intent" value="test" className="btn-secondary">Test</button>
              <SubmitButton>Add source</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}
