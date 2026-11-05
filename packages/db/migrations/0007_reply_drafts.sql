CREATE TYPE "public"."draft_status" AS ENUM('draft', 'sending', 'sent', 'discarded', 'failed');--> statement-breakpoint
CREATE TABLE "email_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"processed_email_id" uuid NOT NULL,
	"application_id" uuid,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_enc" text NOT NULL,
	"chosen_time" text,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"ai_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_settings" ADD COLUMN "interview_availability" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "rfc_message_id" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_processed_email_id_processed_emails_id_fk" FOREIGN KEY ("processed_email_id") REFERENCES "public"."processed_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_drafts_one_open_uq" ON "email_drafts" USING btree ("processed_email_id") WHERE "email_drafts"."status" IN ('draft','sending');