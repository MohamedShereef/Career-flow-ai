import { profile } from "@careerflow/core";
import { savePreferencesAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Select, TextArea } from "@/components/ui";
import { db } from "@/lib/db";

const ARRANGEMENTS = [["onsite", "On-site"], ["hybrid", "Hybrid"], ["remote", "Remote"]] as const;
const EMPLOYER_TYPES = [
  ["client_developer", "Client / developer (project owner)"],
  ["government", "Government entity"],
  ["pmc_consultant", "PMC / consultant"],
  ["tier1_contractor", "Tier-1 main contractor"],
  ["subcontractor", "Subcontractor"],
  ["small_contractor", "Small contractor"],
  ["recruitment_agency", "Recruitment agency"],
] as const;

export async function PreferencesTab({ userId }: { userId: string }) {
  const p = await profile.getProfile(db(), userId);
  const join = (a: string[]) => a.join("\n");
  return (
    <ActionForm action={savePreferencesAction} className="space-y-6">
      <Card title="What you're looking for" description="One per line. Matching reads full job descriptions — these steer it, they aren't keyword filters.">
        <div className="grid gap-4 md:grid-cols-2">
          <TextArea label="Target job titles" name="preferredTitles" defaultValue={join(p.preferredTitles)} placeholder={"Senior Procurement Engineer\nProcurement Manager\nMEP Procurement Lead"} rows={6} />
          <TextArea label="Preferred locations" name="preferredLocations" defaultValue={join(p.preferredLocations)} placeholder={"Riyadh\nJeddah\nSaudi Arabia\nUAE"} rows={6} />
          <TextArea label="Industries" name="industries" defaultValue={join(p.industries)} placeholder={"Construction\nEntertainment & giga-projects\nPMC / client-side"} />
          <div>
            <span className="label">Working arrangement</span>
            <div className="flex gap-4 pt-1">
              {ARRANGEMENTS.map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="workArrangements" value={val} defaultChecked={p.workArrangements.includes(val)} className="accent-brand-600" />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <TextArea label="Preferred companies" name="preferredCompanies" defaultValue={join(p.preferredCompanies)} />
          <TextArea label="Never apply to" name="excludedCompanies" defaultValue={join(p.excludedCompanies)} hint="The agent will skip these employers entirely." />
        </div>
      </Card>
      <Card title="Which employers" description="Every employer is vetted before the agent applies. Types you exclude are rejected automatically; unknown employers wait for your OK.">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <span className="label">Prefer</span>
            <div className="space-y-1.5">
              {EMPLOYER_TYPES.map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="preferredEmployerTypes" value={v} defaultChecked={p.preferredEmployerTypes.includes(v)} className="accent-brand-600" /> {l}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Never apply to</span>
            <div className="space-y-1.5">
              {EMPLOYER_TYPES.map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="excludedEmployerTypes" value={v} defaultChecked={p.excludedEmployerTypes.includes(v)} className="accent-bad" /> {l}
                </label>
              ))}
            </div>
            <div className="mt-4 grid gap-3">
              <Select label="Minimum company size" name="minEmployerScale" defaultValue={p.minEmployerScale} options={[["large", "Large only (national / international leaders, giga-projects)"], ["mid", "Mid-size or larger"], ["any", "Any size"]]} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="preferPif" defaultChecked={p.preferPif} className="accent-brand-600" /> Prioritise PIF-owned companies
              </label>
            </div>
          </div>
        </div>
      </Card>
      <SubmitButton>Save preferences</SubmitButton>
    </ActionForm>
  );
}
