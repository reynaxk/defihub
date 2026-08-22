CREATE TABLE "historical_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"metric" varchar(32) NOT NULL,
	"value" numeric(32, 8) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"block_number" numeric(20, 0),
	"source" varchar(64) NOT NULL,
	"calculation_version" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"address" varchar(128) NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"decimals" integer,
	"coingecko_id" varchar(128),
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_key" varchar(64) NOT NULL,
	"chain_id" uuid NOT NULL,
	"protocol_id" uuid,
	"label" text NOT NULL,
	"address" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pools_config_key_unique" UNIQUE("config_key")
);
--> statement-breakpoint
ALTER TABLE "historical_observations" ADD CONSTRAINT "historical_observations_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_tokens" ADD CONSTRAINT "pool_tokens_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "historical_observations_entity_idx" ON "historical_observations" USING btree ("entity_type","entity_id","metric","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_observations_dedup_unique" ON "historical_observations" USING btree ("entity_type","entity_id","metric","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_tokens_pool_position_unique" ON "pool_tokens" USING btree ("pool_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_chain_address_unique" ON "pools" USING btree ("chain_id","address");