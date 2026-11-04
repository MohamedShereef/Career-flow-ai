/**
 * Saved Answers Knowledge Base + "Questions Waiting for Your Answer" inbox.
 *
 * Lookup order for a question: employer-specific answer → global answer.
 * Answers are encrypted at rest; question identity is an HMAC of the
 * normalized wording, so equivalent wordings resolve to one answer.
 * Sensitive questions (legal declarations, protected categories, identity
 * attestations, conflicts of interest) are always flagged for per-application
 * review even when an answer is saved — a deterministic control the AI cannot override.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { pendingQuestions, savedAnswers } from "@careerflow/db";
import { z } from "zod";
import { decrypt, encrypt, keyedHash } from "../crypto";
import { AppError, notFound } from "../errors";
import { employerKey, normalizeQuestion } from "../normalize";
import type { Db, Executor } from "../types";
import { audit } from "./audit";
import { enqueue } from "./queue";

export type Sensitivity =
  | "normal"
  | "legal_declaration"
  | "protected_category"
  | "identity_attestation"
  | "conflict_of_interest"
  | "salary";

const SENSITIVE_PATTERNS: Array<[Sensitivity, RegExp]> = [
  ["protected_category", /\b(gender|sex|race|ethnic|religio|disabilit|veteran|sexual orientation|pregnan|marital|age group|date of birth)\b/],
  ["legal_declaration", /\b(criminal|convict|felony|offen[cs]e|lawsuit|legal proceeding|sanction|declare|declaration|certify that|i hereby|true and complete|background check)\b/],
  ["identity_attestation", /\b(passport|national id|iqama number|id number|signature|e signature|attest)\b/],
  ["conflict_of_interest", /\b(conflict of interest|related to any employee|relative.*employ|family member.*work|government official|politically exposed)\b/],
  ["salary", /\b(salary|compensation|remuneration|pay expectation|ctc)\b/],
];

export function classifySensitivity(question: string): Sensitivity {
  const q = normalizeQuestion(question);
  for (const [kind, re] of SENSITIVE_PATTERNS) if (re.test(q)) return kind;
  return "normal";
}

/** Salary is sensitive to share but may be reused without per-application review once the user saved it. */
const reviewRequired = (s: Sensitivity) => s !== "normal" && s !== "salary";

export const questionHash = (question: string) => keyedHash(normalizeQuestion(question), "question");

const aad = (userId: string) => `answer:${userId}`;

export const saveAnswerSchema = z.object({
  questionText: z.string().trim().min(2).max(1000),
  answer: z.string().trim().min(1).max(5000),
  scope: z.enum(["global", "employer"]).default("global"),
  employerName: z.string().trim().max(200).nullish(),
  answerType: z.enum(["text", "choice", "multi_choice", "boolean", "number", "date"]).default("text"),
  sensitivity: z
    .enum(["normal", "legal_declaration", "protected_category", "identity_attestation", "conflict_of_interest", "salary"])
    .optional(),
});

export async function saveAnswer(db: Executor, userId: string, input: unknown) {
  const r = saveAnswerSchema.safeParse(input);
  if (!r.success) throw new AppError("invalid_answer", r.error.issues[0]?.message ?? "Invalid answer.");
  const v = r.data;
  const empKey = v.scope === "employer" ? employerKey(v.employerName ?? "") : null;
  if (v.scope === "employer" && !empKey) throw new AppError("employer_required", "Choose the employer this answer applies to.");
  // The user may raise sensitivity but never lower it below what the classifier detects.
  const detected = classifySensitivity(v.questionText);
  const sensitivity: Sensitivity = detected !== "normal" ? detected : (v.sensitivity ?? "normal");

  const values = {
    userId,
    scope: v.scope,
    employerKey: empKey,
    questionText: v.questionText,
    questionHash: questionHash(v.questionText),
    answerEnc: encrypt(v.answer, aad(userId)),
    answerType: v.answerType,
    sensitivity,
    requiresReview: reviewRequired(sensitivity),
    verifiedAt: new Date(),
    updatedAt: new Date(),
  } as const;

  // Expression-based unique index (coalesce(employer_key,'')) → insert-or-update in two steps.
  let [row] = await db.insert(savedAnswers).values(values).onConflictDoNothing().returning();
  if (!row) {
    [row] = await db
      .update(savedAnswers)
      .set({
        questionText: values.questionText,
        answerEnc: values.answerEnc,
        answerType: values.answerType,
        sensitivity: values.sensitivity,
        requiresReview: values.requiresReview,
        verifiedAt: values.verifiedAt,
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(savedAnswers.userId, userId),
          eq(savedAnswers.scope, v.scope),
          sql`coalesce(${savedAnswers.employerKey}, '') = ${empKey ?? ""}`,
          eq(savedAnswers.questionHash, values.questionHash),
        ),
      )
      .returning();
  }
  await audit(db, { userId, actor: "user", action: "answer.saved", entityType: "saved_answer", entityId: row!.id, metadata: { scope: v.scope, sensitivity } });
  return row!;
}

export interface FoundAnswer {
  id: string;
  answer: string;
  scope: "global" | "employer";
  answerType: string;
  sensitivity: Sensitivity;
  requiresReview: boolean;
}

export async function findAnswer(
  db: Executor,
  userId: string,
  question: string,
  employerName?: string | null,
  opts: { markUsed?: boolean } = {},
): Promise<FoundAnswer | null> {
  const hash = questionHash(question);
  const empKey = employerName ? employerKey(employerName) : null;
  const rows = await db
    .select()
    .from(savedAnswers)
    .where(and(eq(savedAnswers.userId, userId), eq(savedAnswers.questionHash, hash)));
  const match =
    (empKey && rows.find((r) => r.scope === "employer" && r.employerKey === empKey)) ||
    rows.find((r) => r.scope === "global");
  if (!match) return null;
  if (opts.markUsed) {
    await db
      .update(savedAnswers)
      .set({ useCount: sql`${savedAnswers.useCount} + 1`, lastUsedAt: new Date() })
      .where(eq(savedAnswers.id, match.id));
  }
  return {
    id: match.id,
    answer: decrypt(match.answerEnc, aad(userId)),
    scope: match.scope,
    answerType: match.answerType,
    sensitivity: match.sensitivity,
    requiresReview: match.requiresReview,
  };
}

export async function listAnswers(db: Executor, userId: string) {
  const rows = await db.select().from(savedAnswers).where(eq(savedAnswers.userId, userId)).orderBy(desc(savedAnswers.updatedAt));
  return rows.map(({ answerEnc, ...r }) => ({ ...r, answer: decrypt(answerEnc, aad(userId)) }));
}

export async function deleteAnswer(db: Db, userId: string, id: string) {
  const res = await db.delete(savedAnswers).where(and(eq(savedAnswers.id, id), eq(savedAnswers.userId, userId))).returning();
  if (!res.length) throw notFound("Answer");
  await audit(db, { userId, actor: "user", action: "answer.deleted", entityType: "saved_answer", entityId: id });
}

// ── Inbox ──

export interface QuestionEncounter {
  questionText: string;
  employerName?: string | null;
  jobTitle?: string | null;
  applicationId?: string | null;
  jobId?: string | null;
  fieldType?: string | null;
  options?: string[] | null;
  required?: boolean;
  context?: string | null;
}

/**
 * Called by the application agent whenever it meets a question.
 * Returns the saved answer if one exists, otherwise files the question in the
 * inbox (once — duplicates across retries are absorbed by a unique index).
 */
export async function resolveOrAsk(db: Executor, userId: string, q: QuestionEncounter) {
  const found = await findAnswer(db, userId, q.questionText, q.employerName, { markUsed: true });
  if (found) return { status: "answered" as const, answer: found };
  const sensitivity = classifySensitivity(q.questionText);
  const empKey = q.employerName ? employerKey(q.employerName) : null;
  await db
    .insert(pendingQuestions)
    .values({
      userId,
      applicationId: q.applicationId ?? null,
      jobId: q.jobId ?? null,
      employerName: q.employerName ?? null,
      employerKey: empKey,
      jobTitle: q.jobTitle ?? null,
      questionText: q.questionText,
      questionHash: questionHash(q.questionText),
      fieldType: q.fieldType ?? null,
      options: q.options ?? null,
      required: q.required ?? true,
      context: q.context ?? null,
      sensitivity,
    })
    .onConflictDoNothing();
  return { status: "waiting" as const };
}

export async function listPendingQuestions(db: Executor, userId: string, status: "open" | "answered" | "dismissed" = "open") {
  return db
    .select()
    .from(pendingQuestions)
    .where(and(eq(pendingQuestions.userId, userId), eq(pendingQuestions.status, status)))
    .orderBy(desc(pendingQuestions.createdAt));
}

/**
 * Answer an inbox question once. Saves the answer, closes every other open
 * question that the new answer now covers, and queues a resume task for each
 * affected application so the agent continues without asking again.
 */
export async function answerPendingQuestion(
  db: Db,
  userId: string,
  pendingId: string,
  input: { answer: string; scope: "global" | "employer" },
) {
  return db.transaction(async (tx) => {
    const [pq] = await tx
      .select()
      .from(pendingQuestions)
      .where(and(eq(pendingQuestions.id, pendingId), eq(pendingQuestions.userId, userId)));
    if (!pq) throw notFound("Question");
    if (pq.status !== "open") throw new AppError("already_answered", "This question was already answered.");
    if (input.scope === "employer" && !pq.employerName) {
      throw new AppError("employer_required", "This question has no employer, so it can only be saved as a general answer.");
    }

    const saved = await saveAnswer(tx, userId, {
      questionText: pq.questionText,
      answer: input.answer,
      scope: input.scope,
      employerName: input.scope === "employer" ? pq.employerName : null,
      answerType: pq.options?.length ? "choice" : "text",
    });

    const covered = await tx
      .update(pendingQuestions)
      .set({ status: "answered", answeredAt: new Date(), savedAnswerId: saved.id })
      .where(
        and(
          eq(pendingQuestions.userId, userId),
          eq(pendingQuestions.status, "open"),
          eq(pendingQuestions.questionHash, pq.questionHash),
          input.scope === "employer" ? eq(pendingQuestions.employerKey, pq.employerKey!) : undefined,
        ),
      )
      .returning({ applicationId: pendingQuestions.applicationId });

    const appIds = [...new Set(covered.map((c) => c.applicationId).filter((x): x is string => !!x))];
    for (const applicationId of appIds) {
      await enqueue(tx, {
        kind: "application.resume",
        userId,
        payload: { applicationId, reason: "question_answered" },
        dedupeKey: `application.resume:${applicationId}`,
      });
    }
    return { savedAnswerId: saved.id, resumedApplications: appIds, closedQuestions: covered.length };
  });
}

export async function dismissPendingQuestion(db: Db, userId: string, id: string) {
  await db
    .update(pendingQuestions)
    .set({ status: "dismissed", answeredAt: new Date() })
    .where(and(eq(pendingQuestions.id, id), eq(pendingQuestions.userId, userId), eq(pendingQuestions.status, "open")));
}

export async function openQuestionCount(db: Executor, userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingQuestions)
    .where(and(eq(pendingQuestions.userId, userId), eq(pendingQuestions.status, "open")));
  return r?.n ?? 0;
}

