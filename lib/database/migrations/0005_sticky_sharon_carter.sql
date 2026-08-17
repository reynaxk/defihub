CREATE TABLE "onchain_verifications" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"protocol_id" uuid,
	"label" text NOT NULL,
	"pool_address" varchar(128) NOT NULL,
	"tvl_usd" numeric(24, 2) NOT NULL,
	"block_number" numeric(20, 0) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onchain_verifications" ADD CONSTRAINT "onchain_verifications_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;