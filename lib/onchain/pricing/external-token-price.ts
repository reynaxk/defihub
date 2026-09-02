import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokenPrices, tokens } from "@/lib/database/schema";

// Phase 5.12: the discovered-pool TVL path's ONLY external-price source -
// a bounded, honest fallback for a token that isn't a REFERENCE_ASSET (see
// getNativeTokenPrice, pricing/queries.ts, tried first by
// resolveDiscoveredTokenPrice). Deliberately reads the ALREADY-SYNCED
// token_prices table (workers/prices/sync.ts's own 15-minute cron) rather
// than calling priceProvider.getPrices() live - the exact same data a
// live call would return moments later, without adding a second live
// CoinGecko round-trip to every TVL verification run. A token this
// codebase's own token-discovery sync has never seen (the overwhelming
// majority of arbitrary discovered-pool tokens - see workers/tokens/sync.ts's
// own top-market-cap-only scope) simply has no row here, and this
// correctly returns null - never a live lookup-by-symbol/guess, which
// could silently attach the wrong asset's price to an unrelated token that
// happens to share a ticker.
export interface ExternalTokenPrice {
  priceUsd: string;
  coingeckoId: string;
  observedAt: Date;
}

export async function getExternalTokenPrice(chainSlug: string, address: string): Promise<ExternalTokenPrice | null> {
  const [row] = await db
    .select({
      priceUsd: tokenPrices.priceUsd,
      coingeckoId: tokens.coingeckoId,
      timestamp: tokenPrices.timestamp,
    })
    .from(tokenPrices)
    .innerJoin(tokens, eq(tokens.id, tokenPrices.tokenId))
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(eq(chains.slug, chainSlug), eq(tokens.address, address.toLowerCase()), isNotNull(tokens.coingeckoId)))
    .orderBy(desc(tokenPrices.timestamp))
    .limit(1);

  if (!row || row.coingeckoId == null) return null;
  return { priceUsd: row.priceUsd, coingeckoId: row.coingeckoId, observedAt: row.timestamp };
}

// Same staleness discipline as isNativeTokenPriceFresh (pricing/queries.ts),
// a genuinely separate threshold rather than a shared constant: the
// external price-refresh cron runs every 15 minutes (workers/prices/sync.ts),
// a much tighter cadence than the native reference-asset engine's own, so
// this window is deliberately tighter too - reusing the native engine's
// (looser) threshold here would accept an external price that's stale by
// this pipeline's own, faster-refreshing standard.
export const MAX_EXTERNAL_PRICE_AGE_MS = 60 * 60 * 1000; // 1 hour

export function isExternalTokenPriceFresh(observedAt: Date, now: Date): boolean {
  const ageMs = now.getTime() - observedAt.getTime();
  if (ageMs < 0) return false;
  return ageMs <= MAX_EXTERNAL_PRICE_AGE_MS;
}
