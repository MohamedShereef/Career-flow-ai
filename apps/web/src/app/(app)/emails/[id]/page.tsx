import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, replies, settings } from "@careerflow/core";
import { discardReplyAction, draftReplyAction, sendReplyAction } from "@/actions/applications";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, PageHeader, TextArea, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Reply" };
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  application_receipt: "Receipt",
  interview_invitation: "Interview invitation",
  assessment: "Assessment",
  rejection: "Not progressing",
  offer: "Offer",
  recruiter_outreach: "Recruiter",
  status_update: "Update",
  other: "Other",
};

export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let v;
  try {
    v = await replies.getForEmail(db(), user.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const s = await settings.getSettings(db(), user.id);
  const { email: e, draft, application } = v;
  const tz = s.timezone;
  const fmt = (t: string) => new Date(t).toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  const times = e.proposedTimes ?? [];
  const who = application?.company ?? e.employerName ?? e.fromDomain ?? "the employer";
  const calTitle = `Interview – ${application?.title ?? e.jobTitle ?? "role"} (${who})`;

  return (
    <>
      <PageHeader
        title={`${LABEL[e.classification] ?? "Email"} · ${who}`}
        subtitle={<>From {e.fromAddress} · {e.receivedAt ? fmtDate(e.receivedAt) : ""}{application && <> · <Link href={`/applications/${application.id}`} className="text-brand-600 hover:underline">{application.title}</Link></>}</>}
        actions={<Link href="/applications" className="btn-secondary">Back</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <Card title="What they wrote">
            <p className="text-sm font-medium">{e.subject}</p>
            <p className="mt-2 text-sm text-slate-700">{e.summary}</p>
            <p className="mt-3 text-xs text-muted">Only this summary is kept. Open Gmail to read the full email.</p>
          </Card>
          {times.length > 0 && (
            <Card title="Times in the email" description={`Shown in ${tz}.`}>
              <ul className="space-y-3 text-sm">
                {times.map((t) => (
                  <li key={t} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{fmt(t)}{draft?.chosenTime === t && <Badge tone="good">chosen</Badge>}</span>
                    <span className="flex gap-2">
                      <a className="text-xs text-brand-600 hover:underline" href={replies.calendarLink(calTitle, t, 60, `Reply thread: ${e.subject ?? ""}`)} target="_blank" rel="noopener">Add to Google Calendar ↗</a>
                    </span>
                  </li>
                ))}
              </ul>
              {times.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {times.map((t) => (
                    <ActionForm key={t} action={draftReplyAction}>
                      <input type="hidden" name="emailId" value={e.id} />
                      <input type="hidden" name="chosenTime" value={t} />
                      <SubmitButton className="btn-secondary" pendingText="Drafting…">Accept {new Date(t).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" })}</SubmitButton>
                    </ActionForm>
                  ))}
                </div>
              )}
            </Card>
          )}
          {!s.interviewAvailability && (
            <p className="text-sm text-muted">Tip: add your usual interview availability in <Link href="/settings?tab=automation" className="text-brand-600 hover:underline">Settings</Link> so replies can offer it when an employer asks.</p>
          )}
        </div>
        <div className="lg:col-span-3">
          <Card title="Your reply" description={`To ${draft?.toAddress ?? e.replyTo ?? e.fromAddress} · sent from your Gmail in the same thread, only when you press Send.`}>
            {draft && draft.status === "sent" ? (
              <div className="space-y-2 text-sm">
                <Badge tone="good">Sent {draft.sentAt ? fmtDate(draft.sentAt) : ""}</Badge>
                <div className="whitespace-pre-line rounded-lg bg-slate-50 p-3">{draft.body}</div>
              </div>
            ) : draft && draft.status === "draft" ? (
              <>
                {draft.error && <p className="mb-3 rounded-lg bg-bad-50 p-3 text-sm text-bad">{draft.error}</p>}
                <ActionForm action={sendReplyAction} className="space-y-3">
                  <input type="hidden" name="draftId" value={draft.id} />
                  <div className="text-xs text-muted">Subject: {draft.subject}</div>
                  <TextArea label="Message (edit anything)" name="body" rows={12} defaultValue={draft.body} required />
                  <div className="flex flex-wrap items-center gap-3">
                    <SubmitButton pendingText="Sending…">Send</SubmitButton>
                  </div>
                </ActionForm>
                <div className="mt-3 flex flex-wrap gap-3">
                  <ActionForm action={draftReplyAction}>
                    <input type="hidden" name="emailId" value={e.id} />
                    {draft.chosenTime && <input type="hidden" name="chosenTime" value={draft.chosenTime} />}
                    <SubmitButton className="btn-secondary" pendingText="Drafting…">Write it again</SubmitButton>
                  </ActionForm>
                  <form action={discardReplyAction}>
                    <input type="hidden" name="draftId" value={draft.id} />
                    <input type="hidden" name="emailId" value={e.id} />
                    <button className="btn-danger">Discard</button>
                  </form>
                </div>
              </>
            ) : (
              <ActionForm action={draftReplyAction}>
                <input type="hidden" name="emailId" value={e.id} />
                <SubmitButton pendingText="Drafting…">Draft a reply</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
