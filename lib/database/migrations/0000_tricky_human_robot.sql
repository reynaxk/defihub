CREATE TYPE "public"."alert_condition" AS ENUM('above', 'below', 'percent_change_up', 'percent_change_down');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('protocol_tvl', 'chain_tvl', 'token_price', 'pool_apy');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "alert_type" NOT NULL,
	"target" text NOT NULL,
	"condition" "alert_condition" NOT NULL,
	"threshold" numeric(24, 8) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"tvl" numeric(24, 2)
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"chain_id" integer,
	"native_token" varchar(32) NOT NULL,
	"logo_url" text,
	"explorer_url" text,
	"defillama_slug" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chains_slug_unique" UNIQUE("slug"),
	CONSTRAINT "chains_defillama_slug_unique" UNIQUE("defillama_slug")
);
--> statement-breakpoint
CREATE TABLE "protocol_chains" (
	"protocol_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"contract_addresses" jsonb,
	CONSTRAINT "protocol_chains_protocol_id_chain_id_pk" PRIMARY KEY("protocol_id","chain_id")
);
--> statement-breakpoint
CREATE TABLE "protocol_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"chain_id" uuid,
	"timestamp" timestamp with time zone NOT NULL,
	"tvl" numeric(24, 2),
	"volume_24h" numeric(24, 2),
	"fees_24h" numeric(24, 2),
	"revenue_24h" numeric(24, 2)
);
--> statement-breakpoint
CREATE TABLE "protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(128) NOT NULL,
	"description" text,
	"website" text,
	"logo_url" text,
	"category" varchar(64),
	"defillama_slug" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protocols_slug_unique" UNIQUE("slug"),
	CONSTRAINT "protocols_defillama_slug_unique" UNIQUE("defillama_slug")
);
--> statement-breakpoint
CREATE TABLE "token_prices" (
	"token_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"price_usd" numeric(24, 8) NOT NULL,
	"market_cap" numeric(24, 2),
	"volume_24h" numeric(24, 2),
	CONSTRAINT "token_prices_token_id_timestamp_pk" PRIMARY KEY("token_id","timestamp")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"address" varchar(128) NOT NULL,
	"symbol" varchar(32) NOT NULL,
	"name" text,
	"decimals" integer DEFAULT 18 NOT NULL,
	"logo_url" text,
	"coingecko_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_token" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_token_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"protocol_id" uuid,
	"chain_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yield_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_pool_id" varchar(128) NOT NULL,
	"protocol_id" uuid,
	"chain_id" uuid NOT NULL,
	"symbol" varchar(128) NOT NULL,
	"underlying_tokens" jsonb,
	"apy" numeric(10, 4),
	"apy_base" numeric(10, 4),
	"apy_reward" numeric(10, 4),
	"tvl_usd" numeric(24, 2),
	"stablecoin" boolean DEFAULT false NOT NULL,
	"il_risk" varchar(16),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yield_pools_external_pool_id_unique" UNIQUE("external_pool_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_metrics" ADD CONSTRAINT "chain_metrics_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_chains" ADD CONSTRAINT "protocol_chains_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_chains" ADD CONSTRAINT "protocol_chains_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_metrics" ADD CONSTRAINT "protocol_metrics_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_metrics" ADD CONSTRAINT "protocol_metrics_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_prices" ADD CONSTRAINT "token_prices_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_pools" ADD CONSTRAINT "yield_pools_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yield_pools" ADD CONSTRAINT "yield_pools_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_user_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alerts_enabled_idx" ON "alerts" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "chain_metrics_chain_ts_idx" ON "chain_metrics" USING btree ("chain_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_metrics_unique_snapshot" ON "chain_metrics" USING btree ("chain_id","timestamp");--> statement-breakpoint
CREATE INDEX "protocol_metrics_protocol_ts_idx" ON "protocol_metrics" USING btree ("protocol_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_metrics_unique_snapshot" ON "protocol_metrics" USING btree ("protocol_id","chain_id","timestamp");--> statement-breakpoint
CREATE INDEX "protocols_category_idx" ON "protocols" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_address_unique" ON "tokens" USING btree ("chain_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_user_protocol_unique" ON "watchlist" USING btree ("user_id","protocol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_user_chain_unique" ON "watchlist" USING btree ("user_id","chain_id");--> statement-breakpoint
CREATE INDEX "yield_pools_chain_idx" ON "yield_pools" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "yield_pools_apy_idx" ON "yield_pools" USING btree ("apy");