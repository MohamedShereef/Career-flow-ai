import { profile } from "@careerflow/core";
import { savePersonalAction } from "@/actions/profile";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, Field, Select, TextArea } from "@/components/ui";
import { db } from "@/lib/db";

export async function PersonalTab({ userId }: { userId: string }) {
  const p = await profile.getProfile(db(), userId);
  const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));
  return (
    <ActionForm action={savePersonalAction} className="space-y-6">
      <Card title="Identity & contact">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" name="fullName" defaultValue={v(p.fullName)} />
          <Field label="Professional headline" name="headline" defaultValue={v(p.headline)} placeholder="Senior Materials & Procurement Engineer" />
          <Field label="Phone" name="phone" defaultValue={v(p.phone)} placeholder="+966 5x xxx xxxx" hint="Encrypted at rest." />
          <Field label="Contact email" name="contactEmail" type="email" defaultValue={v(p.contactEmail)} />
          <Field label="LinkedIn URL" name="linkedinUrl" type="url" defaultValue={v(p.linkedinUrl)} />
          <Field label="City" name="city" defaultValue={v(p.city)} placeholder="Riyadh" />
          <Field label="Region / province" name="region" defaultValue={v(p.region)} placeholder="Riyadh Region" />
          <Field label="Date of birth" name="dateOfBirth" type="date" defaultValue={v(p.dateOfBirth)} hint="Encrypted. Filled only where a form asks." />
          <Field label="Address (district, street)" name="address" defaultValue={v(p.address)} placeholder="Al Olaya, King Fahd Rd" hint="Encrypted." />
          <Field label="Postal code" name="postalCode" defaultValue={v(p.postalCode)} placeholder="12211" />
        </div>
        <div className="mt-4">
          <TextArea label="Professional summary" name="summary" defaultValue={v(p.summary)} hint="Used as the base for tailored summaries. Keep it factual." />
        </div>
      </Card>
      <Card title="Eligibility" description="Used to reject roles you can't legally take (e.g. nationals-only vacancies).">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nationality" name="nationality" defaultValue={v(p.nationality)} />
          <Field label="Country of residence" name="residencyCountry" defaultValue={v(p.residencyCountry)} placeholder="Saudi Arabia" />
          <Field label="Residency / visa details" name="residencyDetails" defaultValue={v(p.residencyDetails)} placeholder="e.g. Iqama holder, transferable" hint="Encrypted. Only used to answer eligibility questions." />
          <Select label="ID document" name="idType" defaultValue={v(p.idType)} options={[["", "—"], ["Iqama", "Iqama (residence ID)"], ["Passport", "Passport"], ["National ID", "National ID"], ["GCC ID", "GCC ID"]]} />
          <Field label="ID number" name="idNumber" defaultValue={v(p.idNumber)} autoComplete="off" hint="Encrypted. Only filled where a form requires it, and any application that uses it is always shown to you before sending." />
          <Field label="Total years of experience" name="yearsExperience" type="number" step="0.5" min="0" defaultValue={v(p.yearsExperience)} />
        </div>
      </Card>
      <Card title="Availability & salary" description="Salaries are encrypted and only shared when an application requires them.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Notice period (days)" name="noticePeriodDays" type="number" min="0" defaultValue={v(p.noticePeriodDays)} />
          <Field label="Available from" name="availableFrom" type="date" defaultValue={v(p.availableFrom)} />
          <div />
          <Field label="Current salary" name="currentSalary" defaultValue={v(p.currentSalary)} />
          <Field label="Expected salary" name="expectedSalary" defaultValue={v(p.expectedSalary)} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Currency" name="salaryCurrency" defaultValue={v(p.salaryCurrency) || "SAR"} />
            <Select label="Per" name="salaryFrequency" defaultValue={v(p.salaryFrequency) || "monthly"} options={[["monthly", "Month"], ["annual", "Year"]]} />
          </div>
        </div>
      </Card>
      <SubmitButton>Save personal details</SubmitButton>
    </ActionForm>
  );
}
