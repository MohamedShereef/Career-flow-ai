/**
 * CareerFlow AI — normalized PostgreSQL schema (Neon-compatible).
 *
 * Conventions
 * - Every user-owned table carries `user_id` and every query in the service
 *   layer filters on it (cross-user isolation is tested).
 * - Columns ending in `_enc` hold AES-256-GCM ciphertext produced by
 *   @careerflow/core/crypto. They are never decrypted in SQL.
 * - Tables that record history (audit_logs, submission_ledger, ai_decisions,
 *   application_events) are append-only; reindexing never touches them.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ───────────────────────────── Enums ─────────────────────────────

export const userRole = pgEnum("user_role", ["user", "admin"]);

export const factStatus = pgEnum("fact_status", ["draft", "verified", "rejected"]);
export const factSource = pgEnum("fact_source", ["user", "cv_extraction"]);

export const documentKind = pgEnum("document_kind", [
  "cv_original",
  "cv_tailored",
  "cover_letter",
  "certificate",
  "supporting",
  "evidence_screenshot",
  "evidence_html",
]);

export const answerScope = pgEnum("answer_scope", ["global", "employer"]);
export const answerType = pgEnum("answer_type", ["text", "choice", "multi_choice", "boolean", "number", "date"]);
export const answerSensitivity = pgEnum("answer_sensitivity", [
  "normal",
  "legal_declaration",
  "protected_category",
  "identity_attestation",
  "conflict_of_interest",
  "salary",
]);
export const pendingQuestionStatus = pgEnum("pending_question_status", ["open", "answered", "dismissed"]);

export const sourceKind = pgEnum("source_kind", [
  "google_jobs",
  "jsearch",
  "workday",
  "successfactors",
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
  "career_site",
  "feed",
  "linkedin_assisted",
  "manual",
]);
export const sourceHealth = pgEnum("source_health", ["unknown", "healthy", "degraded", "failing", "disabled"]);
export const runStatus = pgEnum("run_status", ["running", "succeeded", "partial", "failed"]);
export const jobStatus = pgEnum("job_status", ["active", "closed", "expired"]);

export const evalDecision = pgEnum("eval_decision", ["recommended", "rejected", "needs_review"]);
export const eligibility = pgEnum("eligibility", ["eligible", "ineligible", "uncertain"]);
export const decisionMethod = pgEnum("decision_method", ["ai", "rule", "fallback"]);
export const aiStatus = pgEnum("ai_status", ["ok", "error", "unavailable"]);

/** Mirrors the lifecycle in the spec (Section 10). */
export const applicationStatus = pgEnum("application_status", [
  "discovered",
  "matched",
  "prepared",
  "awaiting_approval",
  "processing",
  "needs_user_action",
  "submitted_unverified",
  "confirmed_by_email",
  "interview",
  "rejected",
  "closed",
  "failed",
  "withdrawn",
]);

export const ledgerState = pgEnum("ledger_state", ["attempting", "submitted", "uncertain", "abandoned"]);
export const evidenceKind = pgEnum("evidence_kind", [
  "website_acknowledgement",
  "confirmation_page",
  "screenshot",
  "upload_check",
  "email_receipt",
]);
export const evidenceLevel = pgEnum("evidence_level", ["website", "email"]);

export const eventKind = pgEnum("event_kind", [
  "ai_decision",
  "browser_action",
  "evidence",
  "status_change",
  "user_action",
  "error",
  "recovery",
]);

export const errorCategory = pgEnum("error_category", [
  "unanswered_question",
  "prefill_conflict",
  "readback_mismatch",
  "render_failure",
  "form_missing",
  "upload_error",
  "captcha",
  "login_required",
  "navigation_timeout",
  "already_submitted",
  "uncertain_submission",
  "ai_unavailable",
  "unsupported_ats",
  "rate_limited",
  "unknown",
]);

export const emailClass = pgEnum("email_class", [
  "application_receipt",
  "interview_invitation",
  "assessment",
  "status_update",
  "rejection",
  "offer",
  "recruiter_outreach",
  "other",
]);
export const emailMatch = pgEnum("email_match", ["matched", "ambiguous", "unmatched"]);
export const integrationStatus = pgEnum("integration_status", ["connected", "expired", "revoked", "error"]);

export const taskStatus = pgEnum("task_status", ["queued", "running", "succeeded", "failed", "dead", "cancelled", "blocked"]);
export const auditActor = pgEnum("audit_actor", ["user", "system", "agent", "admin"]);

// ───────────────────────────── Users & auth ─────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("user"),
    emailVerifiedAt: ts("email_verified_at"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    passwordChangedAt: ts("password_changed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the random cookie token — the raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_reset_token_hash_uq").on(t.tokenHash)],
);

/** Fixed-window counters used for login, signup and reset throttling. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

// ───────────────────────────── Applicant profile ─────────────────────────────

export const applicantProfiles = pgTable(
  "applicant_profiles",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name"),
    headline: text("headline"),
    summary: text("summary"),
    nationality: text("nationality"),
    residencyCountry: text("residency_country"),
    /** e.g. "Iqama holder – transferable", free text as the user states it. */
    residencyDetailsEnc: text("residency_details_enc"),
    city: text("city"),
    phoneEnc: text("phone_enc"),
    contactEmail: text("contact_email"),
    linkedinUrl: text("linkedin_url"),
    yearsExperience: numeric("years_experience", { precision: 4, scale: 1 }),
    noticePeriodDays: integer("notice_period_days"),
    availableFrom: date("available_from"),
    currentSalaryEnc: text("current_salary_enc"),
    expectedSalaryEnc: text("expected_salary_enc"),
    salaryCurrency: text("salary_currency"),
    salaryFrequency: text("salary_frequency"),
    preferredTitles: text("preferred_titles").array().notNull().default(sql`'{}'::text[]`),
    preferredLocations: text("preferred_locations").array().notNull().default(sql`'{}'::text[]`),
    preferredCompanies: text("preferred_companies").array().notNull().default(sql`'{}'::text[]`),
    excludedCompanies: text("excluded_companies").array().notNull().default(sql`'{}'::text[]`),
    workArrangements: text("work_arrangements").array().notNull().default(sql`'{}'::text[]`),
    industries: text("industries").array().notNull().default(sql`'{}'::text[]`),
    /** client_developer | government | pmc_consultant | tier1_contractor | subcontractor | small_contractor | recruitment_agency */
    preferredEmployerTypes: text("preferred_employer_types").array().notNull().default(sql`'{client_developer,government,pmc_consultant,tier1_contractor}'::text[]`),
    excludedEmployerTypes: text("excluded_employer_types").array().notNull().default(sql`'{subcontractor,small_contractor}'::text[]`),
    /** large | mid | any — employers assessed below this are not applied to automatically. */
    minEmployerScale: text("min_employer_scale").notNull().default("large"),
    preferPif: boolean("prefer_pif").notNull().default(true),
    /** Bumped on every material change so matching results can be invalidated. */
    profileVersion: integer("profile_version").notNull().default(1),
    updatedAt: updatedAt(),
  },
);

export const workExperiences = pgTable(
  "work_experiences",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    employer: text("employer").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    isCurrent: boolean("is_current").notNull().default(false),
    description: text("description"),
    status: factStatus("status").notNull().default("verified"),
    source: factSource("source").notNull().default("user"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_exp_user_idx").on(t.userId),
    check("work_exp_dates_chk", sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);

export const qualifications = pgTable(
  "qualifications",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // degree | certification | course | membership
    name: text("name").notNull(),
    issuer: text("issuer"),
    /** held | in_progress | expired — "studying CIPS" must never be rendered as "CIPS certified". */
    state: text("state").notNull().default("held"),
    obtainedOn: date("obtained_on"),
    expiresOn: date("expires_on"),
    credentialId: text("credential_id"),
    status: factStatus("status").notNull().default("verified"),
    source: factSource("source").notNull().default("user"),
    createdAt: createdAt(),
  },
  (t) => [index("qualifications_user_idx").on(t.userId)],
);

export const skills = pgTable(
  "skills",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    years: integer("years"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("skills_user_name_uq").on(t.userId, sql`lower(${t.name})`)],
);

/**
 * Verified career facts. The CV/letter engines may only quote figures that
 * appear here with status = 'verified' (e.g. "negotiated a SAR 60M package",
 * team size 3). `meaning` stores what the user confirmed the number means.
 */
export const careerFacts = pgTable(
  "career_facts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workExperienceId: uuid("work_experience_id").references(() => workExperiences.id, { onDelete: "set null" }),
    category: text("category").notNull(), // achievement | contract_value | team_size | savings | package | other
    statement: text("statement").notNull(),
    numericValue: numeric("numeric_value", { precision: 18, scale: 2 }),
    unit: text("unit"),
    meaning: text("meaning"),
    status: factStatus("status").notNull().default("draft"),
    source: factSource("source").notNull().default("user"),
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("career_facts_user_idx").on(t.userId, t.status),
    check("career_facts_verified_chk", sql`${t.status} <> 'verified' OR ${t.verifiedAt} IS NOT NULL`),
  ],
);

// ───────────────────────────── Documents ─────────────────────────────

export const documents = pgTable(
  "documents",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    applicationId: uuid("application_id"),
    label: text("label"),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("documents_user_kind_idx").on(t.userId, t.kind),
    uniqueIndex("documents_storage_key_uq").on(t.storageKey),
    uniqueIndex("documents_one_primary_cv_uq")
      .on(t.userId)
      .where(sql`${t.isPrimary} AND ${t.kind} = 'cv_original' AND ${t.deletedAt} IS NULL`),
  ],
);

export const cvExtractions = pgTable("cv_extractions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // pending | extracted | confirmed | failed
  extracted: jsonb("extracted"),
  aiDecisionId: uuid("ai_decision_id"),
  createdAt: createdAt(),
  confirmedAt: ts("confirmed_at"),
});

// ───────────────────────────── Saved answers & question inbox ─────────────────────────────

export const savedAnswers = pgTable(
  "saved_answers",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    scope: answerScope("scope").notNull().default("global"),
    /** Normalized employer identity, required when scope = 'employer'. */
    employerKey: text("employer_key"),
    questionText: text("question_text").notNull(),
    /** HMAC of the normalized question — lets us look up without plaintext matching. */
    questionHash: text("question_hash").notNull(),
    answerEnc: text("answer_enc").notNull(),
    answerType: answerType("answer_type").notNull().default("text"),
    sensitivity: answerSensitivity("sensitivity").notNull().default("normal"),
    /** Legal/attestation answers always require per-application review even if saved. */
    requiresReview: boolean("requires_review").notNull().default(false),
    verifiedAt: ts("verified_at").notNull().defaultNow(),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("saved_answers_key_uq").on(t.userId, t.scope, sql`coalesce(${t.employerKey}, '')`, t.questionHash),
    index("saved_answers_lookup_idx").on(t.userId, t.questionHash),
    check("saved_answers_scope_chk", sql`(${t.scope} = 'global') = (${t.employerKey} IS NULL)`),
  ],
);

export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id"),
    jobId: uuid("job_id"),
    employerName: text("employer_name"),
    employerKey: text("employer_key"),
    jobTitle: text("job_title"),
    questionText: text("question_text").notNull(),
    questionHash: text("question_hash").notNull(),
    fieldType: text("field_type"),
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").notNull().default(true),
    context: text("context"),
    sensitivity: answerSensitivity("sensitivity").notNull().default("normal"),
    status: pendingQuestionStatus("status").notNull().default("open"),
    savedAnswerId: uuid("saved_answer_id").references(() => savedAnswers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    answeredAt: ts("answered_at"),
  },
  (t) => [
    index("pending_questions_user_status_idx").on(t.userId, t.status),
    uniqueIndex("pending_questions_open_uq")
      .on(t.userId, sql`coalesce(${t.employerKey}, '')`, t.questionHash)
      .where(sql`${t.status} = 'open'`),
  ],
);

// ───────────────────────────── Discovery ─────────────────────────────

export const jobSources = pgTable(
  "job_sources",
  {
    id: id(),
    kind: sourceKind("kind").notNull(),
    name: text("name").notNull(),
    /** Board token / company slug / feed URL depending on kind. */
    identifier: text("identifier").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    health: sourceHealth("health").notNull().default("unknown"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: ts("last_success_at"),
    lastErrorAt: ts("last_error_at"),
    lastError: text("last_error"),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("job_sources_kind_ident_uq").on(t.kind, sql`lower(${t.identifier})`)],
);

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: id(),
    sourceId: uuid("source_id").references(() => jobSources.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(), // scheduled | manual | reindex
    status: runStatus("status").notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    jobsSeen: integer("jobs_seen").notNull().default(0),
    jobsNew: integer("jobs_new").notNull().default(0),
    jobsUpdated: integer("jobs_updated").notNull().default(0),
    jobsClosed: integer("jobs_closed").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("discovery_runs_source_idx").on(t.sourceId, t.startedAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    sourceId: uuid("source_id").references(() => jobSources.id, { onDelete: "set null" }),
    externalId: text("external_id").notNull(),
    /** Cross-source dedupe: normalized employer + title + location + apply host/path. */
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    companyName: text("company_name").notNull(),
    employerKey: text("employer_key").notNull(),
    location: text("location"),
    country: text("country"),
    remoteType: text("remote_type"),
    employmentType: text("employment_type"),
    description: text("description"),
    descriptionHash: text("description_hash"),
    salaryMin: numeric("salary_min", { precision: 14, scale: 2 }),
    salaryMax: numeric("salary_max", { precision: 14, scale: 2 }),
    salaryCurrency: text("salary_currency"),
    atsKind: text("ats_kind"),
    sourceUrl: text("source_url").notNull(),
    applyUrl: text("apply_url").notNull(),
    status: jobStatus("status").notNull().default("active"),
    postedAt: ts("posted_at"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    raw: jsonb("raw"),
  },
  (t) => [
    uniqueIndex("jobs_source_external_uq").on(t.sourceId, t.externalId),
    uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey),
    index("jobs_status_idx").on(t.status, t.lastSeenAt),
    index("jobs_employer_idx").on(t.employerKey),
  ],
);

export const jobEvaluations = pgTable(
  "job_evaluations",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    profileVersion: integer("profile_version").notNull(),
    jobDescriptionHash: text("job_description_hash"),
    score: integer("score").notNull(),
    decision: evalDecision("decision").notNull(),
    eligibility: eligibility("eligibility").notNull(),
    /** [{factor, weight, score, explanation}] */
    breakdown: jsonb("breakdown").notNull(),
    summary: text("summary").notNull(),
    rejectionReasons: jsonb("rejection_reasons").$type<string[]>().notNull().default([]),
    method: decisionMethod("method").notNull(),
    aiDecisionId: uuid("ai_decision_id"),
    createdAt: createdAt(),
    supersededAt: ts("superseded_at"),
  },
  (t) => [
    uniqueIndex("job_eval_current_uq").on(t.userId, t.jobId).where(sql`${t.supersededAt} IS NULL`),
    index("job_eval_user_score_idx").on(t.userId, t.score),
    check("job_eval_score_chk", sql`${t.score} BETWEEN 0 AND 100`),
  ],
);

// ───────────────────────────── AI decision trace ─────────────────────────────

export const aiDecisions = pgTable(
  "ai_decisions",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(), // discovery | matching | cv_tailoring | form_reasoning | recovery | email_matching | supervisor | cv_extraction
    agent: text("agent").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    method: decisionMethod("method").notNull(),
    status: aiStatus("status").notNull(),
    model: text("model"),
    outcome: text("outcome"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    /** Sanitized: never secrets, never full CV text. */
    inputSummary: text("input_summary"),
    output: jsonb("output"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_decisions_user_stage_idx").on(t.userId, t.stage, t.createdAt),
    index("ai_decisions_entity_idx").on(t.entityType, t.entityId),
  ],
);

// ───────────────────────────── Applications ─────────────────────────────

export const applicationBatches = pgTable("application_batches", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"), // queued | running | completed | cancelled
  requestedCount: integer("requested_count").notNull(),
  mode: text("mode").notNull().default("supervised"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
});

export const applications = pgTable(
  "applications",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id").references(() => applicationBatches.id, { onDelete: "set null" }),
    employerKey: text("employer_key").notNull(),
    status: applicationStatus("status").notNull().default("discovered"),
    statusReason: text("status_reason"),
    /** Resumable checkpoint name, e.g. "form_filled", "awaiting_approval", "submit_clicked". */
    checkpoint: text("checkpoint"),
    checkpointData: jsonb("checkpoint_data"),
    approvedPreviewId: uuid("approved_preview_id"),
    tailoredCvDocumentId: uuid("tailored_cv_document_id"),
    coverLetterDocumentId: uuid("cover_letter_document_id"),
    submittedAt: ts("submitted_at"),
    websiteAcknowledgedAt: ts("website_acknowledged_at"),
    emailConfirmedAt: ts("email_confirmed_at"),
    lastErrorId: uuid("last_error_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("applications_user_job_uq").on(t.userId, t.jobId),
    index("applications_user_status_idx").on(t.userId, t.status),
    index("applications_user_employer_idx").on(t.userId, t.employerKey),
  ],
);

/**
 * Permanent idempotency ledger. One row per (user, job) the agent has ever
 * attempted to submit. Rows are never deleted by resets or reindexing, so a
 * duplicate submission is impossible even after cache clears or restarts.
 */
export const submissionLedger = pgTable(
  "submission_ledger",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    jobDedupeKey: text("job_dedupe_key").notNull(),
    employerKey: text("employer_key").notNull(),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    state: ledgerState("state").notNull().default("attempting"),
    approvalId: uuid("approval_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("submission_ledger_user_job_uq").on(t.userId, t.jobDedupeKey)],
);

export const applicationPreviews = pgTable(
  "application_previews",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** SHA-256 over employer, job, every answer and the resume/cover-letter hashes. */
    contentHash: text("content_hash").notNull(),
    answersEnc: text("answers_enc").notNull(),
    resumeDocumentId: uuid("resume_document_id").references(() => documents.id),
    coverLetterDocumentId: uuid("cover_letter_document_id").references(() => documents.id),
    screenshotDocumentId: uuid("screenshot_document_id").references(() => documents.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("application_previews_version_uq").on(t.applicationId, t.version)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    previewId: uuid("preview_id").notNull().references(() => applicationPreviews.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    jobId: uuid("job_id").notNull(),
    employerKey: text("employer_key").notNull(),
    approvedAt: ts("approved_at").notNull().defaultNow(),
    consumedAt: ts("consumed_at"),
    invalidatedAt: ts("invalidated_at"),
    invalidatedReason: text("invalidated_reason"),
  },
  (t) => [
    uniqueIndex("approvals_one_active_uq")
      .on(t.applicationId)
      .where(sql`${t.invalidatedAt} IS NULL AND ${t.consumedAt} IS NULL`),
  ],
);

export const submissionEvidence = pgTable(
  "submission_evidence",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    kind: evidenceKind("kind").notNull(),
    level: evidenceLevel("level").notNull(),
    summary: text("summary").notNull(),
    url: text("url"),
    documentId: uuid("document_id").references(() => documents.id),
    processedEmailId: uuid("processed_email_id"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [index("submission_evidence_app_idx").on(t.applicationId)],
);

/** Unified execution timeline: AI Decision → Browser Action → Evidence → Status → Next Action. */
export const applicationEvents = pgTable(
  "application_events",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
    kind: eventKind("kind").notNull(),
    stage: text("stage"),
    message: text("message").notNull(),
    details: jsonb("details"),
    aiDecisionId: uuid("ai_decision_id"),
    taskId: uuid("task_id"),
    createdAt: createdAt(),
  },
  (t) => [index("application_events_app_idx").on(t.applicationId, t.createdAt)],
);

// ───────────────────────────── Gmail ─────────────────────────────

export const gmailIntegrations = pgTable("gmail_integrations", {
  id: id(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  googleEmail: text("google_email").notNull(),
  /** "app_password" (IMAP) today; OAuth can be added later. */
  authMethod: text("auth_method").notNull().default("app_password"),
  appPasswordEnc: text("app_password_enc"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  scope: text("scope").notNull(),
  tokenExpiresAt: ts("token_expires_at"),
  status: integrationStatus("status").notNull().default("connected"),
  historyId: text("history_id"),
  lastSyncAt: ts("last_sync_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Minimal metadata only — never full bodies. One row = at most one application. */
export const processedEmails = pgTable(
  "processed_emails",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    threadId: text("thread_id"),
    fromAddress: text("from_address"),
    fromDomain: text("from_domain"),
    subject: text("subject"),
    receivedAt: ts("received_at"),
    classification: emailClass("classification").notNull(),
    matchStatus: emailMatch("match_status").notNull(),
    matchedApplicationId: uuid("matched_application_id").references(() => applications.id, { onDelete: "set null" }),
    candidateApplicationIds: jsonb("candidate_application_ids").$type<string[]>(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    aiDecisionId: uuid("ai_decision_id"),
    /** One-sentence AI summary (the email body itself is never stored). */
    summary: text("summary"),
    employerName: text("employer_name"),
    jobTitle: text("job_title"),
    /** Interview/assessment times stated in the email, ISO strings. */
    proposedTimes: jsonb("proposed_times").$type<string[]>(),
    actionNeeded: boolean("action_needed").notNull().default(false),
    /** Needed to reply in the same thread (headers only). */
    rfcMessageId: text("rfc_message_id"),
    replyTo: text("reply_to"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("processed_emails_msg_uq").on(t.userId, t.gmailMessageId),
    index("processed_emails_app_idx").on(t.matchedApplicationId),
  ],
);

// ───────────────────────────── Errors, recovery, audit ─────────────────────────────

export const errorRecords = pgTable(
  "error_records",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "cascade" }),
    taskId: uuid("task_id"),
    stage: text("stage").notNull(),
    category: errorCategory("category").notNull(),
    /** Stable key for grouping "problems by root cause" on the dashboard. */
    rootCauseKey: text("root_cause_key").notNull(),
    userMessage: text("user_message").notNull(),
    technicalDetail: jsonb("technical_detail"),
    recoveryDecision: jsonb("recovery_decision"),
    recoveryAiDecisionId: uuid("recovery_ai_decision_id"),
    retryCount: integer("retry_count").notNull().default(0),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("error_records_user_idx").on(t.userId, t.createdAt),
    index("error_records_root_cause_idx").on(t.rootCauseKey, t.resolvedAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    actor: auditActor("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_user_idx").on(t.userId, t.createdAt)],
);

// ───────────────────────────── Settings & limits ─────────────────────────────

export const automationSettings = pgTable(
  "automation_settings",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    maxSubmissionsPerDay: integer("max_submissions_per_day").notNull().default(5),
    maxInspectionsPerDay: integer("max_inspections_per_day").notNull().default(15),
    maxBatchSize: integer("max_batch_size").notNull().default(5),
    manualApprovalUntilCount: integer("manual_approval_until_count").notNull().default(5),
    /** Autopilot: find, tailor and prepare applications on its own (submits still need approval until unlocked). */
    autopilotEnabled: boolean("autopilot_enabled").notNull().default(false),
    /** After the first approved applications: submit without asking when every answer is verified. */
    continuousSubmissionEnabled: boolean("continuous_submission_enabled").notNull().default(false),
    matchThreshold: integer("match_threshold").notNull().default(50),
    discoveryIntervalHours: integer("discovery_interval_hours").notNull().default(12),
    timezone: text("timezone").notNull().default("Asia/Riyadh"),
    /** Free text, e.g. "Sun–Thu after 4pm Riyadh time". Used when an employer asks for availability. */
    interviewAvailability: text("interview_availability"),
    automationConsentAt: ts("automation_consent_at"),
    emailTrackingConsentAt: ts("email_tracking_consent_at"),
    outreachConsentAt: ts("outreach_consent_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("automation_limits_chk", sql`
      ${t.maxSubmissionsPerDay} BETWEEN 0 AND 50 AND
      ${t.maxInspectionsPerDay} BETWEEN 0 AND 200 AND
      ${t.maxBatchSize} BETWEEN 1 AND 25 AND
      ${t.matchThreshold} BETWEEN 0 AND 100`),
  ],
);

export const dailyUsage = pgTable(
  "daily_usage",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    submissions: integer("submissions").notNull().default(0),
    inspections: integer("inspections").notNull().default(0),
    aiCostUsd: numeric("ai_cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

// ───────────────────────────── Durable task queue & workers ─────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: taskStatus("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Prevents enqueueing the same logical work twice while it is pending. */
    dedupeKey: text("dedupe_key"),
    lockedBy: text("locked_by"),
    lockedAt: ts("locked_at"),
    heartbeatAt: ts("heartbeat_at"),
    timeoutSeconds: integer("timeout_seconds").notNull().default(600),
    /** Handler-owned resumable state. `irreversible: true` blocks automatic retries. */
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
    result: jsonb("result"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("tasks_claim_idx").on(t.status, t.runAt, t.priority),
    uniqueIndex("tasks_dedupe_pending_uq")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued','running','blocked')`),
    index("tasks_user_idx").on(t.userId, t.createdAt),
  ],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  kind: text("kind").notNull(),
  version: text("version"),
  startedAt: ts("started_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  currentTaskId: uuid("current_task_id"),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
});

export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: ts("next_run_at").notNull().defaultNow(),
    lastRunAt: ts("last_run_at"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex("schedules_user_kind_uq").on(sql`coalesce(${t.userId}::text, '')`, t.kind)],
);

// ───────────────────────────── CV tailoring ─────────────────────────────

/** A tailored CV (and optional cover letter) generated for one job description. */
export const cvTailorings = pgTable(
  "cv_tailorings",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    jobTitle: text("job_title").notNull(),
    companyName: text("company_name").notNull(),
    jobDescription: text("job_description").notNull(),
    profileVersion: integer("profile_version").notNull(),
    /** Structured tailored content (summary, bullets, fact ids, skills, letter). */
    content: jsonb("content").notNull(),
    /** Statements removed by the fact guard because they weren't supported by the profile. */
    guardRemovals: jsonb("guard_removals").$type<string[]>().notNull().default([]),
    cvDocumentId: uuid("cv_document_id").references(() => documents.id, { onDelete: "set null" }),
    coverLetterDocumentId: uuid("cover_letter_document_id").references(() => documents.id, { onDelete: "set null" }),
    aiDecisionId: uuid("ai_decision_id"),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("cv_tailorings_user_idx").on(t.userId, t.createdAt)],
);

// ───────────────────────────── Reply drafts ─────────────────────────────

export const draftStatus = pgEnum("draft_status", ["draft", "sending", "sent", "discarded", "failed"]);

/** A reply CareerFlow drafted to an employer email. Sent only when the user presses Send. */
export const emailDrafts = pgTable(
  "email_drafts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    processedEmailId: uuid("processed_email_id").notNull().references(() => processedEmails.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyEnc: text("body_enc").notNull(),
    chosenTime: text("chosen_time"),
    status: draftStatus("status").notNull().default("draft"),
    sentAt: ts("sent_at"),
    error: text("error"),
    aiDecisionId: uuid("ai_decision_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_drafts_one_open_uq").on(t.processedEmailId).where(sql`${t.status} IN ('draft','sending')`)],
);

// ───────────────────────────── Saved portal logins ─────────────────────────────

/**
 * The user's own account on an employer's application portal (Workday, SuccessFactors…).
 * Encrypted per user + host; only ever used on that exact host.
 */
export const portalLogins = pgTable(
  "portal_logins",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    label: text("label"),
    usernameEnc: text("username_enc").notNull(),
    passwordEnc: text("password_enc").notNull(),
    lastUsedAt: ts("last_used_at"),
    lastResult: text("last_result"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("portal_logins_user_host_uq").on(t.userId, t.host)],
);

// ───────────────────────────── Employer vetting ─────────────────────────────

/** One AI assessment per employer, shared by all users and refreshed periodically. */
export const employerAssessments = pgTable("employer_assessments", {
  employerKey: text("employer_key").primaryKey(),
  companyName: text("company_name").notNull(),
  /** client_developer | government | pmc_consultant | tier1_contractor | subcontractor | small_contractor | recruitment_agency | other | unknown */
  employerType: text("employer_type").notNull(),
  /** large | mid | small | unknown */
  scale: text("scale").notNull(),
  pifAffiliated: text("pif_affiliated").notNull().default("unknown"), // yes | no | unknown
  summary: text("summary"),
  redFlags: jsonb("red_flags").$type<string[]>().notNull().default([]),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  method: decisionMethod("method").notNull(),
  aiDecisionId: uuid("ai_decision_id"),
  assessedAt: ts("assessed_at").notNull().defaultNow(),
});
