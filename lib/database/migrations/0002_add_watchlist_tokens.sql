ALTER TABLE "watchlist" ADD COLUMN "token_id" uuid;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_user_token_unique" ON "watchlist" USING btree ("user_id","token_id");