CREATE TABLE "swap_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"transaction_hash" varchar(128) NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" numeric(20, 0) NOT NULL,
	"block_hash" varchar(128) NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"sender" varchar(128),
	"amount0_in" numeric(78, 0) NOT NULL,
	"amount1_in" numeric(78, 0) NOT NULL,
	"amount0_out" numeric(78, 0) NOT NULL,
	"amount1_out" numeric(78, 0) NOT NULL,
	"reorg_invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swap_events" ADD CONSTRAINT "swap_events_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_events" ADD CONSTRAINT "swap_events_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swap_events_pool_tx_log_unique" ON "swap_events" USING btree ("pool_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "swap_events_pool_block_idx" ON "swap_events" USING btree ("pool_id","block_number");