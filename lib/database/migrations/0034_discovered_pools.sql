CREATE TYPE "public"."discovered_pool_status" AS ENUM('discovered', 'active', 'rejected');--> statement-breakpoint
CREATE TABLE "discovered_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"deployment_key" varchar(64) NOT NULL,
	"factory_address" varchar(128) NOT NULL,
	"pool_address" varchar(128) NOT NULL,
	"token0_address" varchar(128) NOT NULL,
	"token1_address" varchar(128) NOT NULL,
	"token0_decimals" integer,
	"token1_decimals" integer,
	"token0_symbol" varchar(64),
	"token1_symbol" varchar(64),
	"creation_block_number" numeric(20, 0) NOT NULL,
	"creation_block_hash" varchar(128) NOT NULL,
	"creation_transaction_hash" varchar(128) NOT NULL,
	"creation_log_index" integer NOT NULL,
	"status" "discovered_pool_status" DEFAULT 'discovered' NOT NULL,
	"rejection_reason" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"reorg_invalidated_at" timestamp with time zone,
	"pool_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_pools" ADD CONSTRAINT "discovered_pools_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_pools" ADD CONSTRAINT "discovered_pools_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_pools_chain_address_unique" ON "discovered_pools" USING btree ("chain_id","pool_address");--> statement-breakpoint
CREATE INDEX "discovered_pools_deployment_status_idx" ON "discovered_pools" USING btree ("deployment_key","status");