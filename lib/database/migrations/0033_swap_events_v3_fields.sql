ALTER TABLE "swap_events" ADD COLUMN "sqrt_price_x96" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "swap_events" ADD COLUMN "liquidity" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "swap_events" ADD COLUMN "tick" integer;