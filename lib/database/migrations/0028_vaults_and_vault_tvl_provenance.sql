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
-- Added NOT VALID, deliberately not followed by VALIDATE CONSTRAINT (both
-- hand-edited onto drizzle-kit's plain generated ADD CONSTRAINT) - the same
-- pattern already established for the pool CHECK constraint in migration
-- 0026 (historical_observations_pool_tvl_requires_block_identity), applied
-- here for a different reason: unlike that one, there are no pre-existing
-- "vault" rows to grandfather (entityType "vault" is brand new as of this
-- migration) - the concern here is purely deployment cost. A validated
-- ADD CONSTRAINT ... CHECK (...) scans and locks the entire table to
-- confirm no row violates it, regardless of how few rows the constraint's
-- own condition actually applies to (entity_type = 'vault') - on a
-- historical_observations table that may hold a large number of real pool
-- observations by the time this runs against a live deployment, that scan
-- is unnecessary cost and lock time to pay for a rule no existing row could
-- ever violate (no "vault" row exists yet to check). NOT VALID takes only a
-- brief metadata lock (SHARE UPDATE EXCLUSIVE), applies the rule to every
-- new INSERT/UPDATE from this moment forward, and is never followed by a
-- separate VALIDATE CONSTRAINT step here, mirroring 0026's own choice not
-- to run one - there is no established "validate later" migration workflow
-- in this repository to invoke instead.
ALTER TABLE "historical_observations" ADD CONSTRAINT "historical_observations_vault_tvl_requires_block_identity" CHECK ("historical_observations"."entity_type" <> 'vault' OR "historical_observations"."metric" <> 'tvl_usd' OR ("historical_observations"."block_number" IS NOT NULL AND "historical_observations"."block_hash" IS NOT NULL AND "historical_observations"."block_hash" <> '')) NOT VALID;