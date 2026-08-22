ALTER TABLE "historical_observations" ADD COLUMN "block_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "historical_observations" ADD COLUMN "price_source" varchar(64);--> statement-breakpoint
ALTER TABLE "historical_observations" ADD COLUMN "price_retrieved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "historical_observations" ADD COLUMN "calculation_inputs" jsonb;