import { REFERENCE_ASSETS } from "./config";
import { getNativeTokenPrice } from "./queries";
import type { PriceConfidence } from "./types";

// Phase 5.3's controlled TVL source-selection policy: NEVER a blanket
// replacement of CoinGecko across every pool, only a per-token override for
// the specific reference assets this engine has actually priced on-chain,
// and only when that price's own confidence clears a real bar. LOW/INVALID
// confidence prices are never used here - a comfortable, corroborated
// on-chain price is worth preferring over CoinGecko; a shaky, single-source,
// thinly-liquid one is not worth the risk to an already-working pipeline.
const SUFFICIENT_CONFIDENCE_FOR_TVL: ReadonlySet<PriceConfidence> = new Set(["HIGH", "MEDIUM"]);

// For every requested coingeckoId that matches a configured reference asset
// AND has a sufficiently-confident native price on record, returns that
// price - exact decimal string, ready to substitute directly into a
// priceById map (verify-pool.ts's own `Map<coingeckoId, exact decimal
// string>` shape). A coingeckoId with no native price, or one below the
// confidence bar, or one that isn't a configured reference asset at all,
// simply isn't in the returned map - the caller's own existing CoinGecko
// price for it is untouched.
export async function resolveNativePriceOverrides(coingeckoIds: readonly string[]): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();
  const relevant = REFERENCE_ASSETS.filter((a) => coingeckoIds.includes(a.coingeckoId));

  for (const asset of relevant) {
    const native = await getNativeTokenPrice(asset.chainSlug, asset.address);
    if (native && SUFFICIENT_CONFIDENCE_FOR_TVL.has(native.confidence)) {
      overrides.set(asset.coingeckoId, native.priceUsd);
    }
  }

  return overrides;
}

// Pure - what priceSource a pool's observation should be tagged with, given
// which of its own tokens' coingeckoIds actually got a native override this
// run. Every token natively priced -> ONCHAIN_NATIVE's own tag; none ->
// unchanged external tag; a genuine mix -> HYBRID, since the resulting TVL
// figure combines both kinds of input and must not be mislabeled as either
// one alone (see lib/onchain/pricing/types.ts's PriceLabel comment on why
// mislabeling either direction is never acceptable).
export function priceSourceForTokens(coingeckoIds: readonly string[], nativelyPricedIds: ReadonlySet<string>, externalProviderName: string): string {
  if (coingeckoIds.length === 0) return externalProviderName;
  const allNative = coingeckoIds.every((id) => nativelyPricedIds.has(id));
  if (allNative) return "onchain-pricing-engine";
  const someNative = coingeckoIds.some((id) => nativelyPricedIds.has(id));
  return someNative ? `hybrid:onchain-pricing-engine+${externalProviderName}` : externalProviderName;
}
