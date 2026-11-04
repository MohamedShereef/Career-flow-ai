CREATE TABLE "cv_tailorings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid,
	"job_title" text NOT NULL,
	"company_name" text NOT NULL,
	"job_description" text NOT NULL,
	"profile_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"guard_removals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cv_document_id" uuid,
	"cover_letter_document_id" uuid,
	"ai_decision_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_cv_document_id_documents_id_fk" FOREIGN KEY ("cv_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_cover_letter_document_id_documents_id_fk" FOREIGN KEY ("cover_letter_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cv_tailorings_user_idx" ON "cv_tailorings" USING btree ("user_id","created_at");