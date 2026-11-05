CREATE TABLE "portal_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"host" text NOT NULL,
	"label" text,
	"username_enc" text NOT NULL,
	"password_enc" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_logins" ADD CONSTRAINT "portal_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_logins_user_host_uq" ON "portal_logins" USING btree ("user_id","host");