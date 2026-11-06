ALTER TABLE "automation_settings" ADD COLUMN "daily_limits_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Limits are off now: work that was pushed to tomorrow by the old daily limit runs right away.
UPDATE "tasks" SET "run_at" = now() WHERE "status" = 'queued' AND "kind" IN ('application.prepare', 'application.submit') AND "run_at" > now();--> statement-breakpoint
UPDATE "applications" SET "status_reason" = NULL WHERE "status_reason" LIKE 'Daily limit of %';
