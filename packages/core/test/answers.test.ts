import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { savedAnswers, tasks } from "@careerflow/db";
import * as answers from "../src/services/answers";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);

describe("saved answers", () => {
  it("prefers employer-specific over global and encrypts at rest", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await answers.saveAnswer(db, user.id, { questionText: "What is your notice period?", answer: "60 days" });
    await answers.saveAnswer(db, user.id, { questionText: "What is your notice period?", answer: "30 days (negotiated)", scope: "employer", employerName: "FCC Construcción S.A." });

    expect((await answers.findAnswer(db, user.id, "what is your notice period", "FCC Construccion"))?.answer).toBe("30 days (negotiated)");
    expect((await answers.findAnswer(db, user.id, "What is your notice period?", "Other Co"))?.answer).toBe("60 days");

    const raw = await db.select().from(savedAnswers).where(eq(savedAnswers.userId, user.id));
    expect(raw.every((r) => !r.answerEnc.includes("days"))).toBe(true);
  });

  it("updates in place instead of duplicating", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await answers.saveAnswer(db, user.id, { questionText: "Expected salary?", answer: "SAR 30,000" });
    await answers.saveAnswer(db, user.id, { questionText: "expected salary", answer: "SAR 32,000" });
    const rows = await answers.listAnswers(db, user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("SAR 32,000");
  });

  it("flags legal and protected questions for review and can't be downgraded", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const row = await answers.saveAnswer(db, user.id, { questionText: "Have you ever been convicted of a criminal offence?", answer: "No", sensitivity: "normal" });
    expect(row.sensitivity).toBe("legal_declaration");
    expect(row.requiresReview).toBe(true);
    expect(answers.classifySensitivity("What is your gender?")).toBe("protected_category");
    expect(answers.classifySensitivity("Years of procurement experience?")).toBe("normal");
  });

  it("files unknown questions once and resumes every waiting application when answered", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const appA = crypto.randomUUID();
    const appB = crypto.randomUUID();
    const q = "Do you hold a valid Saudi driving licence?";
    expect((await answers.resolveOrAsk(db, user.id, { questionText: q, employerName: "Acme", applicationId: appA })).status).toBe("waiting");
    // same question again (retry) at same employer → absorbed
    await answers.resolveOrAsk(db, user.id, { questionText: q + " *", employerName: "Acme", applicationId: appA });
    await answers.resolveOrAsk(db, user.id, { questionText: q, employerName: "Beta", applicationId: appB });
    const open = await answers.listPendingQuestions(db, user.id);
    expect(open).toHaveLength(2);

    const res = await answers.answerPendingQuestion(db, user.id, open[0]!.id, { answer: "Yes", scope: "global" });
    expect(res.closedQuestions).toBe(2);
    expect(res.resumedApplications.sort()).toEqual([appA, appB].sort());
    expect(await answers.openQuestionCount(db, user.id)).toBe(0);

    const resumeTasks = await db.select().from(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.kind, "application.resume")));
    expect(resumeTasks).toHaveLength(2);

    // next encounter is answered from the knowledge base
    const next = await answers.resolveOrAsk(db, user.id, { questionText: q, employerName: "Gamma" });
    expect(next.status).toBe("answered");
  });

  it("isolates users", async () => {
    const a = await makeUser("a");
    const b = await makeUser("b");
    const db = testDb();
    const saved = await answers.saveAnswer(db, a.user.id, { questionText: "Nationality?", answer: "Egyptian" });
    expect(await answers.findAnswer(db, b.user.id, "Nationality?")).toBeNull();
    expect(await answers.listAnswers(db, b.user.id)).toHaveLength(0);
    await expect(answers.deleteAnswer(db, b.user.id, saved.id)).rejects.toMatchObject({ code: "not_found" });
    const [still] = await db.select({ n: sql<number>`count(*)::int` }).from(savedAnswers).where(eq(savedAnswers.id, saved.id));
    expect(still!.n).toBe(1);
  });
});
