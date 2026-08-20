CREATE TYPE "public"."indexing_state_status" AS ENUM('idle', 'running', 'error');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "indexing_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_slug" varchar(64) NOT NULL,
	"component" varchar(128) NOT NULL,
	"last_processed_block" numeric(20, 0),
	"last_successful_sync_at" timestamp with time zone,
	"last_attempted_sync_at" timestamp with time zone,
	"status" "indexing_state_status" DEFAULT 'idle' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker" varchar(64) NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"records_processed" integer,
	"records_created" integer,
	"records_updated" integer,
	"error_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "indexing_state_chain_component_unique" ON "indexing_state" USING btree ("chain_slug","component");--> statement-breakpoint
CREATE INDEX "sync_runs_worker_started_idx" ON "sync_runs" USING btree ("worker","started_at");