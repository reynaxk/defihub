ALTER TABLE "tokens" ALTER COLUMN "decimals" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "decimals" DROP NOT NULL;--> statement-breakpoint
-- Every existing row's decimals value is the old NOT NULL DEFAULT 18 -
-- confirmed via code audit that no write path (workers/tokens/sync.ts) has
-- ever set it to anything else, since CoinGecko's bulk markets endpoint
-- (the only writer until this migration's companion code change) doesn't
-- return per-token decimals at all. That "18" was therefore never real
-- data - it was an unverified fabricated default that happened to be
-- displayed as if confirmed, and is wrong for most 6/8-decimal tokens
-- (e.g. USDT, USDC). This reset makes the already-unknown state honest and
-- queryable instead of confidently wrong; a future sync run repopulates
-- real values via an on-chain decimals() read.
UPDATE "tokens" SET "decimals" = NULL;