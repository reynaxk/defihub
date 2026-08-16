CREATE TABLE "protocol_ai_summaries" (
	"protocol_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protocol_ai_summaries" ADD CONSTRAINT "protocol_ai_summaries_protocol_id_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."protocols"("id") ON DELETE cascade ON UPDATE no action;