ALTER TYPE "public"."email_class" ADD VALUE 'offer' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."email_class" ADD VALUE 'recruiter_outreach' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "gmail_integrations" ALTER COLUMN "refresh_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_integrations" ADD COLUMN "auth_method" text DEFAULT 'app_password' NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_integrations" ADD COLUMN "app_password_enc" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "employer_name" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "proposed_times" jsonb;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "action_needed" boolean DEFAULT false NOT NULL;