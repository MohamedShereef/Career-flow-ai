import { profile } from "@careerflow/core";
import { savePreferencesAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, TextArea } from "@/components/ui";
import { db } from "@/lib/db";

const ARRANGEMENTS = [["onsite", "On-site"], ["hybrid", "Hybrid"], ["remote", "Remote"]] as const;

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
      <SubmitButton>Save preferences</SubmitButton>
    </ActionForm>
  );
}
