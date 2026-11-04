import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, profile, tailor } from "@careerflow/core";
import { approveTailoringAction } from "@/actions/cv";
import { Badge, Card, PageHeader, fmtDate } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Tailored CV" };

export default async function Tailored({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let t;
  try {
    t = await tailor.getTailoring(db(), user.id, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const [exps, facts] = await Promise.all([profile.listExperiences(db(), user.id), profile.listCareerFacts(db(), user.id, true)]);
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
