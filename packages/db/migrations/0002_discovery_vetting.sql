ALTER TYPE "public"."source_kind" ADD VALUE 'workday' BEFORE 'greenhouse';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'successfactors' BEFORE 'greenhouse';--> statement-breakpoint
CREATE TABLE "employer_assessments" (
	"employer_key" text PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"employer_type" text NOT NULL,
	"scale" text NOT NULL,
	"pif_affiliated" text DEFAULT 'unknown' NOT NULL,
	"summary" text,
	"red_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"method" "decision_method" NOT NULL,
	"ai_decision_id" uuid,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applicant_profiles" ADD COLUMN "preferred_employer_types" text[] DEFAULT '{client_developer,government,pmc_consultant,tier1_contractor}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "applicant_profiles" ADD COLUMN "excluded_employer_types" text[] DEFAULT '{subcontractor,small_contractor}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "applicant_profiles" ADD COLUMN "min_employer_scale" text DEFAULT 'large' NOT NULL;--> statement-breakpoint
ALTER TABLE "applicant_profiles" ADD COLUMN "prefer_pif" boolean DEFAULT true NOT NULL;