CREATE TYPE "public"."ai_status" AS ENUM('ok', 'error', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."answer_scope" AS ENUM('global', 'employer');--> statement-breakpoint
CREATE TYPE "public"."answer_sensitivity" AS ENUM('normal', 'legal_declaration', 'protected_category', 'identity_attestation', 'conflict_of_interest', 'salary');--> statement-breakpoint
CREATE TYPE "public"."answer_type" AS ENUM('text', 'choice', 'multi_choice', 'boolean', 'number', 'date');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('discovered', 'matched', 'prepared', 'awaiting_approval', 'processing', 'needs_user_action', 'submitted_unverified', 'confirmed_by_email', 'interview', 'rejected', 'closed', 'failed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('user', 'system', 'agent', 'admin');--> statement-breakpoint
CREATE TYPE "public"."decision_method" AS ENUM('ai', 'rule', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('cv_original', 'cv_tailored', 'cover_letter', 'certificate', 'supporting', 'evidence_screenshot', 'evidence_html');--> statement-breakpoint
CREATE TYPE "public"."eligibility" AS ENUM('eligible', 'ineligible', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."email_class" AS ENUM('application_receipt', 'interview_invitation', 'assessment', 'status_update', 'rejection', 'other');--> statement-breakpoint
CREATE TYPE "public"."email_match" AS ENUM('matched', 'ambiguous', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."error_category" AS ENUM('unanswered_question', 'prefill_conflict', 'readback_mismatch', 'render_failure', 'form_missing', 'upload_error', 'captcha', 'login_required', 'navigation_timeout', 'already_submitted', 'uncertain_submission', 'ai_unavailable', 'unsupported_ats', 'rate_limited', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."eval_decision" AS ENUM('recommended', 'rejected', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('ai_decision', 'browser_action', 'evidence', 'status_change', 'user_action', 'error', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('website_acknowledgement', 'confirmation_page', 'screenshot', 'upload_check', 'email_receipt');--> statement-breakpoint
CREATE TYPE "public"."evidence_level" AS ENUM('website', 'email');--> statement-breakpoint
CREATE TYPE "public"."fact_source" AS ENUM('user', 'cv_extraction');--> statement-breakpoint
CREATE TYPE "public"."fact_status" AS ENUM('draft', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('active', 'closed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ledger_state" AS ENUM('attempting', 'submitted', 'uncertain', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."pending_question_status" AS ENUM('open', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_health" AS ENUM('unknown', 'healthy', 'degraded', 'failing', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'career_site', 'feed', 'linkedin_assisted', 'manual');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"stage" text NOT NULL,
	"agent" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"method" "decision_method" NOT NULL,
	"status" "ai_status" NOT NULL,
	"model" text,
	"outcome" text,
	"confidence" numeric(4, 3),
	"input_summary" text,
	"output" jsonb,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applicant_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"headline" text,
	"summary" text,
	"nationality" text,
	"residency_country" text,
	"residency_details_enc" text,
	"city" text,
	"phone_enc" text,
	"contact_email" text,
	"linkedin_url" text,
	"years_experience" numeric(4, 1),
	"notice_period_days" integer,
	"available_from" date,
	"current_salary_enc" text,
	"expected_salary_enc" text,
	"salary_currency" text,
	"salary_frequency" text,
	"preferred_titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_companies" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_companies" text[] DEFAULT '{}'::text[] NOT NULL,
	"work_arrangements" text[] DEFAULT '{}'::text[] NOT NULL,
	"industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_count" integer NOT NULL,
	"mode" text DEFAULT 'supervised' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"stage" text,
	"message" text NOT NULL,
	"details" jsonb,
	"ai_decision_id" uuid,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"answers_enc" text NOT NULL,
	"resume_document_id" uuid,
	"cover_letter_document_id" uuid,
	"screenshot_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"batch_id" uuid,
	"employer_key" text NOT NULL,
	"status" "application_status" DEFAULT 'discovered' NOT NULL,
	"status_reason" text,
	"checkpoint" text,
	"checkpoint_data" jsonb,
	"approved_preview_id" uuid,
	"tailored_cv_document_id" uuid,
	"cover_letter_document_id" uuid,
	"submitted_at" timestamp with time zone,
	"website_acknowledged_at" timestamp with time zone,
	"email_confirmed_at" timestamp with time zone,
	"last_error_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"job_id" uuid NOT NULL,
	"employer_key" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"actor" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"metadata" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"max_submissions_per_day" integer DEFAULT 5 NOT NULL,
	"max_inspections_per_day" integer DEFAULT 15 NOT NULL,
	"max_batch_size" integer DEFAULT 5 NOT NULL,
	"manual_approval_until_count" integer DEFAULT 5 NOT NULL,
	"continuous_submission_enabled" boolean DEFAULT false NOT NULL,
	"match_threshold" integer DEFAULT 50 NOT NULL,
	"discovery_interval_hours" integer DEFAULT 12 NOT NULL,
	"timezone" text DEFAULT 'Asia/Riyadh' NOT NULL,
	"automation_consent_at" timestamp with time zone,
	"email_tracking_consent_at" timestamp with time zone,
	"outreach_consent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_limits_chk" CHECK (
      "automation_settings"."max_submissions_per_day" BETWEEN 0 AND 50 AND
      "automation_settings"."max_inspections_per_day" BETWEEN 0 AND 200 AND
      "automation_settings"."max_batch_size" BETWEEN 1 AND 25 AND
      "automation_settings"."match_threshold" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "career_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_experience_id" uuid,
	"category" text NOT NULL,
	"statement" text NOT NULL,
	"numeric_value" numeric(18, 2),
	"unit" text,
	"meaning" text,
	"status" "fact_status" DEFAULT 'draft' NOT NULL,
	"source" "fact_source" DEFAULT 'user' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_facts_verified_chk" CHECK ("career_facts"."status" <> 'verified' OR "career_facts"."verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "cv_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"extracted" jsonb,
	"ai_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"submissions" integer DEFAULT 0 NOT NULL,
	"inspections" integer DEFAULT 0 NOT NULL,
	"ai_cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "daily_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"trigger" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"jobs_seen" integer DEFAULT 0 NOT NULL,
	"jobs_new" integer DEFAULT 0 NOT NULL,
	"jobs_updated" integer DEFAULT 0 NOT NULL,
	"jobs_closed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"application_id" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "error_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"application_id" uuid,
	"task_id" uuid,
	"stage" text NOT NULL,
	"category" "error_category" NOT NULL,
	"root_cause_key" text NOT NULL,
	"user_message" text NOT NULL,
	"technical_detail" jsonb,
	"recovery_decision" jsonb,
	"recovery_ai_decision_id" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_email" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text NOT NULL,
	"scope" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"status" "integration_status" DEFAULT 'connected' NOT NULL,
	"history_id" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_integrations_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "job_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"job_description_hash" text,
	"score" integer NOT NULL,
	"decision" "eval_decision" NOT NULL,
	"eligibility" "eligibility" NOT NULL,
	"breakdown" jsonb NOT NULL,
	"summary" text NOT NULL,
	"rejection_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method" "decision_method" NOT NULL,
	"ai_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "job_eval_score_chk" CHECK ("job_evaluations"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "source_kind" NOT NULL,
	"name" text NOT NULL,
	"identifier" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" "source_health" DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"external_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"company_name" text NOT NULL,
	"employer_key" text NOT NULL,
	"location" text,
	"country" text,
	"remote_type" text,
	"employment_type" text,
	"description" text,
	"description_hash" text,
	"salary_min" numeric(14, 2),
	"salary_max" numeric(14, 2),
	"salary_currency" text,
	"ats_kind" text,
	"source_url" text NOT NULL,
	"apply_url" text NOT NULL,
	"status" "job_status" DEFAULT 'active' NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"job_id" uuid,
	"employer_name" text,
	"employer_key" text,
	"job_title" text,
	"question_text" text NOT NULL,
	"question_hash" text NOT NULL,
	"field_type" text,
	"options" jsonb,
	"required" boolean DEFAULT true NOT NULL,
	"context" text,
	"sensitivity" "answer_sensitivity" DEFAULT 'normal' NOT NULL,
	"status" "pending_question_status" DEFAULT 'open' NOT NULL,
	"saved_answer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text,
	"from_address" text,
	"from_domain" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"classification" "email_class" NOT NULL,
	"match_status" "email_match" NOT NULL,
	"matched_application_id" uuid,
	"candidate_application_ids" jsonb,
	"confidence" numeric(4, 3),
	"ai_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text,
	"state" text DEFAULT 'held' NOT NULL,
	"obtained_on" date,
	"expires_on" date,
	"credential_id" text,
	"status" "fact_status" DEFAULT 'verified' NOT NULL,
	"source" "fact_source" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "answer_scope" DEFAULT 'global' NOT NULL,
	"employer_key" text,
	"question_text" text NOT NULL,
	"question_hash" text NOT NULL,
	"answer_enc" text NOT NULL,
	"answer_type" "answer_type" DEFAULT 'text' NOT NULL,
	"sensitivity" "answer_sensitivity" DEFAULT 'normal' NOT NULL,
	"requires_review" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_answers_scope_chk" CHECK (("saved_answers"."scope" = 'global') = ("saved_answers"."employer_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"years" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"level" "evidence_level" NOT NULL,
	"summary" text NOT NULL,
	"url" text,
	"document_id" uuid,
	"processed_email_id" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_dedupe_key" text NOT NULL,
	"employer_key" text NOT NULL,
	"application_id" uuid,
	"state" "ledger_state" DEFAULT 'attempting' NOT NULL,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"dedupe_key" text,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"timeout_seconds" integer DEFAULT 600 NOT NULL,
	"checkpoint" jsonb,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"employer" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"is_current" boolean DEFAULT false NOT NULL,
	"description" text,
	"status" "fact_status" DEFAULT 'verified' NOT NULL,
	"source" "fact_source" DEFAULT 'user' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_exp_dates_chk" CHECK ("work_experiences"."end_date" IS NULL OR "work_experiences"."end_date" >= "work_experiences"."start_date")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"current_task_id" uuid,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicant_profiles" ADD CONSTRAINT "applicant_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_batches" ADD CONSTRAINT "application_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_previews" ADD CONSTRAINT "application_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_previews" ADD CONSTRAINT "application_previews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_previews" ADD CONSTRAINT "application_previews_resume_document_id_documents_id_fk" FOREIGN KEY ("resume_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_previews" ADD CONSTRAINT "application_previews_cover_letter_document_id_documents_id_fk" FOREIGN KEY ("cover_letter_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_previews" ADD CONSTRAINT "application_previews_screenshot_document_id_documents_id_fk" FOREIGN KEY ("screenshot_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_batch_id_application_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."application_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_preview_id_application_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."application_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_facts" ADD CONSTRAINT "career_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_facts" ADD CONSTRAINT "career_facts_work_experience_id_work_experiences_id_fk" FOREIGN KEY ("work_experience_id") REFERENCES "public"."work_experiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_extractions" ADD CONSTRAINT "cv_extractions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_extractions" ADD CONSTRAINT "cv_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_records" ADD CONSTRAINT "error_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_records" ADD CONSTRAINT "error_records_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_integrations" ADD CONSTRAINT "gmail_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_evaluations" ADD CONSTRAINT "job_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_evaluations" ADD CONSTRAINT "job_evaluations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_saved_answer_id_saved_answers_id_fk" FOREIGN KEY ("saved_answer_id") REFERENCES "public"."saved_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_matched_application_id_applications_id_fk" FOREIGN KEY ("matched_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_answers" ADD CONSTRAINT "saved_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_evidence" ADD CONSTRAINT "submission_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_evidence" ADD CONSTRAINT "submission_evidence_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_evidence" ADD CONSTRAINT "submission_evidence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_ledger" ADD CONSTRAINT "submission_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_ledger" ADD CONSTRAINT "submission_ledger_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_experiences" ADD CONSTRAINT "work_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_decisions_user_stage_idx" ON "ai_decisions" USING btree ("user_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "ai_decisions_entity_idx" ON "ai_decisions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "application_events_app_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "application_previews_version_uq" ON "application_previews" USING btree ("application_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_job_uq" ON "applications" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX "applications_user_status_idx" ON "applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "applications_user_employer_idx" ON "applications" USING btree ("user_id","employer_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_active_uq" ON "approvals" USING btree ("application_id") WHERE "approvals"."invalidated_at" IS NULL AND "approvals"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "career_facts_user_idx" ON "career_facts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "discovery_runs_source_idx" ON "discovery_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE INDEX "documents_user_kind_idx" ON "documents" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_storage_key_uq" ON "documents" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_one_primary_cv_uq" ON "documents" USING btree ("user_id") WHERE "documents"."is_primary" AND "documents"."kind" = 'cv_original' AND "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "error_records_user_idx" ON "error_records" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "error_records_root_cause_idx" ON "error_records" USING btree ("root_cause_key","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_eval_current_uq" ON "job_evaluations" USING btree ("user_id","job_id") WHERE "job_evaluations"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "job_eval_user_score_idx" ON "job_evaluations" USING btree ("user_id","score");--> statement-breakpoint
CREATE UNIQUE INDEX "job_sources_kind_ident_uq" ON "job_sources" USING btree ("kind",lower("identifier"));--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_external_uq" ON "jobs" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "jobs_employer_idx" ON "jobs" USING btree ("employer_key");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_uq" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "pending_questions_user_status_idx" ON "pending_questions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_questions_open_uq" ON "pending_questions" USING btree ("user_id",coalesce("employer_key", ''),"question_hash") WHERE "pending_questions"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "processed_emails_msg_uq" ON "processed_emails" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "processed_emails_app_idx" ON "processed_emails" USING btree ("matched_application_id");--> statement-breakpoint
CREATE INDEX "qualifications_user_idx" ON "qualifications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_answers_key_uq" ON "saved_answers" USING btree ("user_id","scope",coalesce("employer_key", ''),"question_hash");--> statement-breakpoint
CREATE INDEX "saved_answers_lookup_idx" ON "saved_answers" USING btree ("user_id","question_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_user_kind_uq" ON "schedules" USING btree (coalesce("user_id"::text, ''),"kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_user_name_uq" ON "skills" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "submission_evidence_app_idx" ON "submission_evidence" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_ledger_user_job_uq" ON "submission_ledger" USING btree ("user_id","job_dedupe_key");--> statement-breakpoint
CREATE INDEX "tasks_claim_idx" ON "tasks" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_pending_uq" ON "tasks" USING btree ("dedupe_key") WHERE "tasks"."dedupe_key" IS NOT NULL AND "tasks"."status" IN ('queued','running','blocked');--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "work_exp_user_idx" ON "work_experiences" USING btree ("user_id");