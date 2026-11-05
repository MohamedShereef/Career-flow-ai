CREATE TYPE "public"."feedback_signal" AS ENUM('not_interested', 'approved', 'cancelled', 'applied', 'interview', 'rejected', 'offer');--> statement-breakpoint
CREATE TABLE "field_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"signature" text NOT NULL,
	"field_group" text NOT NULL,
	"strategy" text NOT NULL,
	"steps" jsonb,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"signal" "feedback_signal" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "field_recipes_uq" ON "field_recipes" USING btree ("host","signature","strategy");--> statement-breakpoint
CREATE UNIQUE INDEX "job_feedback_uq" ON "job_feedback" USING btree ("user_id","job_id","signal");--> statement-breakpoint
CREATE INDEX "job_feedback_user_idx" ON "job_feedback" USING btree ("user_id","created_at");