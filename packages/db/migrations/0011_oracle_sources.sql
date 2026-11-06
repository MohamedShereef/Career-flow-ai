ALTER TYPE "public"."source_kind" ADD VALUE 'oracle' BEFORE 'career_site';--> statement-breakpoint
-- Jobs already read from employers' own careers sites are official, whatever the site's domain.
UPDATE "jobs" SET "raw" = coalesce("raw", '{}'::jsonb) || '{"official": true}'::jsonb
WHERE "source_id" IN (SELECT "id" FROM "job_sources" WHERE "kind"::text NOT IN ('google_jobs', 'jsearch'));
