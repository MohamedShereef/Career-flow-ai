"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError, ai, answers, cvImport, documents, profile, settings } from "@careerflow/core";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { list, optStr, runAction, str, type ActionState } from "@/lib/action";

const done = (msg?: string) => {
  revalidatePath("/", "layout");
  return msg;
};

export async function savePersonalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const num = (k: string) => (optStr(fd, k) === null ? null : Number(optStr(fd, k)));
    await profile.updateProfile(db(), user.id, {
      fullName: optStr(fd, "fullName"),
      headline: optStr(fd, "headline"),
      summary: optStr(fd, "summary"),
      nationality: optStr(fd, "nationality"),
      residencyCountry: optStr(fd, "residencyCountry"),
      residencyDetails: optStr(fd, "residencyDetails"),
      city: optStr(fd, "city"),
      phone: optStr(fd, "phone"),
      contactEmail: optStr(fd, "contactEmail"),
      linkedinUrl: optStr(fd, "linkedinUrl"),
      yearsExperience: num("yearsExperience"),
      noticePeriodDays: num("noticePeriodDays"),
      availableFrom: optStr(fd, "availableFrom"),
      currentSalary: optStr(fd, "currentSalary"),
      expectedSalary: optStr(fd, "expectedSalary"),
      salaryCurrency: optStr(fd, "salaryCurrency"),
      salaryFrequency: (optStr(fd, "salaryFrequency") as "monthly" | "annual" | null) ?? null,
    });
    return done("Personal details saved.");
  });
}

export async function savePreferencesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await profile.updateProfile(db(), user.id, {
      preferredTitles: list(fd, "preferredTitles"),
      preferredLocations: list(fd, "preferredLocations"),
      preferredCompanies: list(fd, "preferredCompanies"),
      excludedCompanies: list(fd, "excludedCompanies"),
      industries: list(fd, "industries"),
      workArrangements: fd.getAll("workArrangements").map(String),
    });
    return done("Job preferences saved.");
  });
}

export async function saveExperienceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await profile.upsertExperience(
      db(),
      user.id,
      {
        employer: str(fd, "employer"),
        title: str(fd, "title"),
        location: optStr(fd, "location"),
        startDate: str(fd, "startDate"),
        endDate: optStr(fd, "endDate"),
        isCurrent: fd.get("isCurrent") === "on",
        description: optStr(fd, "description"),
      },
      optStr(fd, "id") ?? undefined,
    );
    return done("Experience saved.");
  });
}

export async function deleteExperienceAction(fd: FormData) {
  const user = await requireUser();
  await profile.deleteExperience(db(), user.id, str(fd, "id"));
  done();
}

export async function addQualificationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await profile.addQualification(db(), user.id, {
      kind: str(fd, "kind"),
      name: str(fd, "name"),
      issuer: optStr(fd, "issuer"),
      state: str(fd, "state") || "held",
      obtainedOn: optStr(fd, "obtainedOn"),
      expiresOn: optStr(fd, "expiresOn"),
    });
    return done("Qualification added.");
  });
}

export async function deleteQualificationAction(fd: FormData) {
  const user = await requireUser();
  await profile.deleteQualification(db(), user.id, str(fd, "id"));
  done();
}

export async function addSkillsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const added = await profile.addSkills(db(), user.id, list(fd, "skills"), optStr(fd, "category"));
    return done(added.length ? `Added ${added.length} skill${added.length > 1 ? "s" : ""}.` : "Those skills are already on your profile.");
  });
}

export async function deleteSkillAction(fd: FormData) {
  const user = await requireUser();
  await profile.deleteSkill(db(), user.id, str(fd, "id"));
  done();
}

export async function addFactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await profile.addCareerFact(db(), user.id, {
      category: str(fd, "category"),
      statement: str(fd, "statement"),
      numericValue: optStr(fd, "numericValue")?.replace(/,/g, "") ?? null,
      unit: optStr(fd, "unit"),
      meaning: optStr(fd, "meaning"),
      workExperienceId: optStr(fd, "workExperienceId"),
    });
    return done("Saved as a draft. Verify it to let the CV engine use it.");
  });
}

export async function verifyFactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await profile.verifyCareerFact(db(), user.id, str(fd, "id"), optStr(fd, "meaning"));
    return done("Verified. This fact can now appear in tailored CVs.");
  });
}

export async function rejectFactAction(fd: FormData) {
  const user = await requireUser();
  await profile.rejectCareerFact(db(), user.id, str(fd, "id"));
  done();
}

export async function deleteFactAction(fd: FormData) {
  const user = await requireUser();
  await profile.deleteCareerFact(db(), user.id, str(fd, "id"));
  done();
}

export async function uploadDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  let importId: string | null = null;
  const state = await runAction(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("no_file", "Choose a file to upload.");
    const kind = (str(fd, "kind") || "cv_original") as documents.UserDocumentKind;
    if (!["cv_original", "certificate", "supporting"].includes(kind)) throw new AppError("bad_kind", "Unknown document type.");
    const doc = await documents.uploadDocument(db(), user.id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, kind, optStr(fd, "label"));
    done();
    // A CV is read straight away so the profile can be filled from it.
    if (kind === "cv_original" && ai.aiConfigured()) {
      try {
        importId = (await cvImport.extractFromCv(db(), user.id, doc.id)).id;
      } catch (err) {
        const why = err instanceof AppError ? err.userMessage : "the AI step failed";
        return `Uploaded, but reading it automatically didn't work: ${why} You can retry with “Fill my profile from this CV”.`;
      }
    }
    return "Uploaded.";
  });
  if (importId) redirect(`/profile/import/${importId}`);
  return state;
}

export async function setPrimaryCvAction(fd: FormData) {
  const user = await requireUser();
  await documents.setPrimaryCv(db(), user.id, str(fd, "id"));
  done();
}

export async function deleteDocumentAction(fd: FormData) {
  const user = await requireUser();
  await documents.deleteDocument(db(), user.id, str(fd, "id"));
  done();
}

export async function saveAnswerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await answers.saveAnswer(db(), user.id, {
      questionText: str(fd, "questionText"),
      answer: str(fd, "answer"),
      scope: str(fd, "scope") || "global",
      employerName: optStr(fd, "employerName"),
      answerType: str(fd, "answerType") || "text",
    });
    return done("Answer saved. The agent will reuse it automatically.");
  });
}

export async function deleteAnswerAction(fd: FormData) {
  const user = await requireUser();
  await answers.deleteAnswer(db(), user.id, str(fd, "id"));
  done();
}

export async function answerQuestionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    const r = await answers.answerPendingQuestion(db(), user.id, str(fd, "id"), {
      answer: str(fd, "answer"),
      scope: (str(fd, "scope") || "global") as "global" | "employer",
    });
    return done(
      r.resumedApplications.length
        ? `Saved. ${r.resumedApplications.length} application(s) will continue automatically.`
        : "Saved. The agent won't ask this again.",
    );
  });
}

export async function dismissQuestionAction(fd: FormData) {
  const user = await requireUser();
  await answers.dismissPendingQuestion(db(), user.id, str(fd, "id"));
  done();
}

export async function saveAutomationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  return runAction(async () => {
    await settings.updateSettings(db(), user.id, {
      maxSubmissionsPerDay: str(fd, "maxSubmissionsPerDay"),
      maxInspectionsPerDay: str(fd, "maxInspectionsPerDay"),
      maxBatchSize: str(fd, "maxBatchSize"),
      matchThreshold: str(fd, "matchThreshold"),
      discoveryIntervalHours: str(fd, "discoveryIntervalHours"),
      timezone: str(fd, "timezone") || "Asia/Riyadh",
    });
    return done("Automation settings saved.");
  });
}

export async function consentAction(fd: FormData) {
  const user = await requireUser();
  const kind = str(fd, "kind") as settings.ConsentKind;
  if (!["automation", "email_tracking", "outreach"].includes(kind)) return;
  await settings.setConsent(db(), user.id, kind, str(fd, "granted") === "1");
  done();
}
