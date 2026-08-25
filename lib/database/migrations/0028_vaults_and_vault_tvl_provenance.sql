CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_key" varchar(64) NOT NULL,
	"chain_id" uuid NOT NULL,
	"protocol_id" uuid,
	"label" text NOT NULL,
	"address" varchar(128) NOT NULL,
	"underlying_address" varchar(128) NOT NULL,
	"underlying_symbol" varchar(32) NOT NULL,
	"underlying_decimals" integer NOT NULL,
	"underlying_coingecko_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaults_config_key_unique" UNIQUE("config_key")
);
--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vaults_chain_address_unique" ON "vaults" USING btree ("chain_id","address");--> statement-breakpoint
ALTER TABLE "historical_observations" ADD CONSTRAINT "historical_observations_vault_tvl_requires_block_identity" CHECK ("historical_observations"."entity_type" <> 'vault' OR "historical_observations"."metric" <> 'tvl_usd' OR ("historical_observations"."block_number" IS NOT NULL AND "historical_observations"."block_hash" IS NOT NULL AND "historical_observations"."block_hash" <> ''));