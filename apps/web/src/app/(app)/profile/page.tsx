import Link from "next/link";
import { answers } from "@careerflow/core";
import { PageHeader } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { PersonalTab } from "./_tabs/personal";
import { PreferencesTab } from "./_tabs/preferences";
import { ExperienceTab } from "./_tabs/experience";
import { QualificationsTab } from "./_tabs/qualifications";
import { HighlightsTab } from "./_tabs/highlights";
import { DocumentsTab } from "./_tabs/documents";
import { AnswersTab } from "./_tabs/answers";
import { QuestionsTab } from "./_tabs/questions";

export const metadata = { title: "My Profile" };

const TABS = [
  ["personal", "Personal & eligibility"],
  ["preferences", "Job preferences"],
  ["experience", "Experience"],
  ["qualifications", "Qualifications & skills"],
  ["highlights", "Verified highlights"],
  ["documents", "CVs & documents"],
  ["answers", "Saved answers"],
  ["questions", "Questions inbox"],
] as const;

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ tab?: string; welcome?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "personal";
  const open = await answers.openQuestionCount(db(), user.id);

  return (
    <>
      <PageHeader title="My Profile" subtitle="The agent only uses what's here. Nothing is invented — numbers and achievements must be verified by you." />
      {sp.welcome && (
        <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm text-brand-700">
          Welcome! Start with your personal details, then add experience and upload your CV. Your data is encrypted and private to your account.
        </div>
      )}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([key, label]) => (
          <Link
            key={key}
            href={`/profile?tab=${key}`}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-brand-600 text-brand-700" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
            {key === "questions" && open > 0 && <span className="rounded-full bg-attention px-1.5 text-xs text-white">{open}</span>}
          </Link>
        ))}
      </div>
      {tab === "personal" && <PersonalTab userId={user.id} />}
      {tab === "preferences" && <PreferencesTab userId={user.id} />}
      {tab === "experience" && <ExperienceTab userId={user.id} />}
      {tab === "qualifications" && <QualificationsTab userId={user.id} />}
      {tab === "highlights" && <HighlightsTab userId={user.id} />}
      {tab === "documents" && <DocumentsTab userId={user.id} />}
      {tab === "answers" && <AnswersTab userId={user.id} />}
      {tab === "questions" && <QuestionsTab userId={user.id} />}
    </>
  );
}
