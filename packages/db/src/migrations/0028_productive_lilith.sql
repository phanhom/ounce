CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"platform" text,
	"arch" text,
	"node_version" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_concurrency" integer DEFAULT 4 NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"active_runs" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workers_token_hash_idx" ON "workers" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workers_company_status_idx" ON "workers" USING btree ("company_id","status");