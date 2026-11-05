import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, applications, autoapply, profile, settings, tailor } from "@careerflow/core";
import { autoApplyAction, markSubmittedAction, saveApplyLinkAction } from "@/actions/applications";
import { approveTailoringAction } from "@/actions/cv";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Field, PageHeader, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Tailored CV" };

export default async function Tailored({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { error } = await searchParams;
  let t;
  try {
    t = await tailor.getTailoring(db(), user.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const [exps, facts, apply, s] = await Promise.all([
    profile.listExperiences(db(), user.id),
    profile.listCareerFacts(db(), user.id, true),
    applications.getForTailoring(db(), user.id, id),
    settings.getSettings(db(), user.id),
  ]);
  const autoInFlight = apply.application && ["processing", "awaiting_approval", "needs_user_action"].includes(apply.application.status) && apply.application.checkpoint !== "opened_apply_page";
  const ats = apply.job ? autoapply.atsFromUrl(apply.job.applyUrl) : null;
  const autoSupported = ats !== null && (autoapply.SUPPORTED_ATS as readonly string[]).includes(ats);
  const submitted = apply.ledger?.state === "submitted" || ["submitted_unverified", "confirmed_by_email", "interview", "rejected", "closed"].includes(apply.application?.status ?? "");
  let host = "";
  try { host = apply.job ? new URL(apply.job.applyUrl).hostname.replace(/^www\./, "") : ""; } catch {}
  const expById = new Map(exps.map((e) => [e.id, e]));
  const factById = new Map(facts.map((f) => [f.id, f]));
  const c = t.content;

  return (
    <>
      <PageHeader
        title={`${t.jobTitle} · ${t.companyName}`}
        subtitle={`Created ${fmtDate(t.createdAt)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {t.cvDocumentId && <a className="btn-primary" href={`/api/documents/${t.cvDocumentId}`} target="_blank">Download CV (PDF)</a>}
            {t.coverLetterDocumentId && <a className="btn-secondary" href={`/api/documents/${t.coverLetterDocumentId}`} target="_blank">Cover letter (PDF)</a>}
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {t.approvedAt ? (
          <Badge tone="good">Approved {fmtDate(t.approvedAt)} — this version will be used for this application</Badge>
        ) : (
          <form action={approveTailoringAction}>
            <input type="hidden" name="id" value={t.id} />
            <button className="btn-secondary">I've checked it — approve this version</button>
          </form>
        )}
        <Link href="/jobs" className="text-sm text-brand-600 hover:underline">Tailor another</Link>
      </div>

      {error && <p className="mb-4 rounded-lg bg-bad-50 p-3 text-sm text-bad">{error}</p>}
      {t.approvedAt && (
        <div className="mb-6">
          <Card title="Apply" description={submitted ? undefined : "Apply on the employer's official page with the CV and cover letter above. When you've pressed their final Submit, come back and confirm so it's tracked and never sent twice."}>
            {submitted ? (
              <p className="text-sm"><Badge tone="good">Applied{apply.application?.submittedAt ? ` ${fmtDate(apply.application.submittedAt)}` : ""}</Badge> <Link href="/applications" className="ml-2 text-brand-600 hover:underline">Track it in Applications →</Link></p>
            ) : !apply.job ? (
              <ActionForm action={saveApplyLinkAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="tailoringId" value={t.id} />
                <div className="min-w-72 flex-1"><Field label="Link to the job's application page" name="applyUrl" type="url" placeholder="https://…" required /></div>
                <SubmitButton pendingText="Saving…">Save link</SubmitButton>
              </ActionForm>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-brand-100 bg-brand-50 p-3">
                  <div className="text-sm font-medium text-brand-700">Let CareerFlow apply for you</div>
                  {autoInFlight ? (
                    <p className="mt-1 text-sm">In progress. <Link href={`/applications/${apply.application!.id}`} className="font-medium text-brand-700 hover:underline">See it and approve →</Link></p>
                  ) : !s.automationConsentAt ? (
                    <p className="mt-1 text-sm text-slate-700">First allow “Fill and submit applications” in <Link href="/settings?tab=consent" className="text-brand-700 hover:underline">Settings → Consent</Link>.</p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-slate-700">
                        It opens {host || "the employer's page"}, fills the form from your profile, uploads this CV, and shows you everything before pressing Submit.
                        {apply.job && autoapply.isJobBoardUrl(apply.job.applyUrl)
                          ? ` Note: this link is on ${host}, a job site that reposts jobs. CareerFlow will try to follow it to ${t.companyName}'s own page; if it can't, it will ask you for the employer's link.`
                          : !autoSupported && " This employer's system usually needs an account — if so it will tell you and you apply with the steps below."}
                      </p>
                      <ActionForm action={autoApplyAction} className="mt-2">
                        <input type="hidden" name="jobId" value={apply.job.id} />
                        <input type="hidden" name="tailoringId" value={t.id} />
                        <SubmitButton pendingText="Starting…">Fill the application for me</SubmitButton>
                      </ActionForm>
                    </>
                  )}
                </div>
                <div className="text-xs font-medium uppercase text-muted">Or apply yourself</div>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
                  <li>Download the CV{t.coverLetterDocumentId ? " and cover letter" : ""} above.</li>
                  <li>Open the employer's page, upload them and answer their questions.</li>
                  <li>After you press their final Submit, confirm here.</li>
                </ol>
                <div className="flex flex-wrap items-center gap-3">
                  <a className="btn-primary" href={`/api/apply/${t.id}`} target="_blank" rel="noopener">Apply on {host || "the employer's site"} ↗</a>
                  {apply.application && (
                    <ActionForm action={markSubmittedAction}>
                      <input type="hidden" name="applicationId" value={apply.application.id} />
                      <SubmitButton className="btn-secondary" pendingText="Saving…">I've submitted it</SubmitButton>
                    </ActionForm>
                  )}
                </div>
                {!apply.application && <p className="text-xs text-muted">“I've submitted it” appears after you open the employer's page — refresh this page when you come back.</p>}
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Summary">
            <p className="text-xs uppercase text-muted">{c.headline}</p>
            <p className="mt-1 text-sm">{c.summary}</p>
          </Card>
          {c.highlightIds.length > 0 && (
            <Card title="Key achievements used" description="Pulled word-for-word from your verified highlights.">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {c.highlightIds.map((h) => factById.get(h) && <li key={h}>{factById.get(h)!.statement}</li>)}
              </ul>
            </Card>
          )}
          <Card title="Experience — original vs tailored">
            <div className="space-y-5">
              {c.experiences.map((x) => {
                const e = expById.get(x.experienceId);
                if (!e) return null;
                return (
                  <div key={x.experienceId}>
                    <div className="font-medium">{e.title} — {e.employer}</div>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg bg-slate-50 p-3 text-xs">
                        <div className="mb-1 font-semibold text-muted">Your original</div>
                        <div className="whitespace-pre-line text-slate-600">{e.description || "—"}</div>
                      </div>
                      <div className="rounded-lg bg-brand-50 p-3 text-xs">
                        <div className="mb-1 font-semibold text-brand-700">Tailored</div>
                        <ul className="list-disc space-y-1 pl-4">{x.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          {c.coverLetter && (
            <Card title="Cover letter">
              <div className="whitespace-pre-line text-sm">{c.coverLetter}</div>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="What changed">
            <ul className="list-disc space-y-1 pl-5 text-sm">{c.changes.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </Card>
          <Card title="Requirements you match">
            <div className="flex flex-wrap gap-1.5">{c.matchedRequirements.map((x, i) => <Badge key={i} tone="good">{x}</Badge>)}</div>
          </Card>
          {c.gaps.length > 0 && (
            <Card title="Gaps" description="Not evidenced in your profile. Nothing was invented to cover them — prepare to address them in an interview.">
              <ul className="list-disc space-y-1 pl-5 text-sm">{c.gaps.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </Card>
          )}
          {c.removedByGuard.length > 0 && (
            <Card title="Removed by the fact check" description="The AI wrote these, but they weren't backed by your profile, so they were taken out.">
              <ul className="list-disc space-y-1 pl-5 text-sm text-bad">{c.removedByGuard.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
