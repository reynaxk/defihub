import type { PriceSourceObservation } from "@/lib/database/schema";
import { REFERENCE_ASSETS } from "./config";
import { getNativeTokenPrice, isNativeTokenPriceFresh } from "./queries";
import type { PriceConfidence } from "./types";

// Phase 5.3's controlled TVL source-selection policy: NEVER a blanket
// replacement of CoinGecko across every pool, only a per-token override for
// the specific reference assets this engine has actually priced on-chain,
// and only when that price's own confidence clears a real bar. LOW/INVALID
// confidence prices are never used here - a comfortable, corroborated
// on-chain price is worth preferring over CoinGecko; a shaky, single-source,
// thinly-liquid one is not worth the risk to an already-working pipeline.
const SUFFICIENT_CONFIDENCE_FOR_TVL: ReadonlySet<PriceConfidence> = new Set(["HIGH", "MEDIUM"]);

// Everything a caller needs to both USE a native override (priceUsd) and
// PERSIST honest provenance for it - see verify-pool.ts's verifyAllPools,
// which attaches this directly onto the relevant token's own
// calculationInputs entry (HistoricalObservationCalculationInput's own
// nativePriceProvenance field, schema.ts). Deliberately not collapsed down
// to a bare priceUsd string the way an earlier version of this function
// did - that lost the source-level identity and block provenance a native
// price is supposed to carry, undermining the whole point of this being an
// on-chain-derived price rather than an opaque number.
export interface NativePriceOverride {
  priceUsd: string;
  sources: PriceSourceObservation[];
  observedAt: Date;
  blockNumber: number | null;
  blockHash: string | null;
}

// For every requested coingeckoId that matches a configured reference asset,
// has a sufficiently-confident native price on record, AND is recent enough
// to still be trusted right now (see isNativeTokenPriceFresh -
// queries.ts - confidence alone says nothing about how long ago a price was
// observed), returns the full override - ready both to substitute into a
// priceById map (verify-pool.ts's own `Map<coingeckoId, exact decimal
// string>` shape, via `.priceUsd`) and to persist as honest provenance. A
// coingeckoId with no native price, one below the confidence bar, one that's
// gone stale, or one that isn't a configured reference asset at all, simply
// isn't in the returned map - the caller's own existing CoinGecko price and
// provenance for it are untouched. `now` is injected (not `new Date()`
// internally) so freshness stays deterministically testable, the same
// convention aggregate.ts's aggregatePrices already established.
// Pure - the actual eligibility decision, extracted specifically so it's
// directly unit-testable with plain constructed inputs (confidence x
// freshness), no RPC/DB involved - the same "orchestration stays thin, the
// real decision is a pure function" pattern this whole codebase already
// uses (resolveVaultOutcome in verify-vault.ts, resolveReferenceAssetOutcome
// above). Confidence and freshness are independent, both-required gates:
// a HIGH-confidence price observed an hour ago is not automatically still
// correct, and a fresh LOW-confidence price was never trustworthy to begin
// with regardless of how recent it is.
// Freshness itself is fully delegated to isNativeTokenPriceFresh
// (queries.ts), never re-implemented here - a future-dated observation
// (observedAt after `now`, e.g. from a clock skew or a corrupted row) is
// rejected by that one shared function, so this path and
// getNativeTokenPrice's own direct callers stay protected consistently by
// construction, not by two independently-maintained checks.
export function isNativePriceEligibleForTvl(confidence: PriceConfidence, observedAt: Date, now: Date): boolean {
  return SUFFICIENT_CONFIDENCE_FOR_TVL.has(confidence) && isNativeTokenPriceFresh(observedAt, now);
}

// For every requested coingeckoId that matches a configured reference asset,
// has a sufficiently-confident native price on record, AND is recent enough
// to still be trusted right now (see isNativePriceEligibleForTvl above -
// confidence alone says nothing about how long ago a price was observed),
// returns the full override - ready both to substitute into a priceById map
// (verify-pool.ts's own `Map<coingeckoId, exact decimal string>` shape, via
// `.priceUsd`) and to persist as honest provenance. A coingeckoId with no
// native price, one below the confidence bar, one that's gone stale, or one
// that isn't a configured reference asset at all, simply isn't in the
// returned map - the caller's own existing CoinGecko price and provenance
// for it are untouched. `now` is injected (not `new Date()` internally) so
// freshness stays deterministically testable, the same convention
// aggregate.ts's aggregatePrices already established.
export async function resolveNativePriceOverrides(coingeckoIds: readonly string[], now: Date = new Date()): Promise<Map<string, NativePriceOverride>> {
  const overrides = new Map<string, NativePriceOverride>();
  const relevant = REFERENCE_ASSETS.filter((a) => coingeckoIds.includes(a.coingeckoId));

  for (const asset of relevant) {
    const native = await getNativeTokenPrice(asset.chainSlug, asset.address);
    // A stale (or insufficiently confident) native price is left in place
    // as canonical history unchanged - this check never touches the
    // underlying historical_observations row, and never invalidates it.
    // It's simply not eligible to override the external fallback for a
    // decision being made right now; the caller falls back to its existing
    // CoinGecko price for this coingeckoId exactly as if no native price
    // existed at all.
    if (!native || !isNativePriceEligibleForTvl(native.confidence, native.observedAt, now)) continue;

    overrides.set(asset.coingeckoId, {
      priceUsd: native.priceUsd,
      sources: native.sources,
      observedAt: native.observedAt,
      blockNumber: native.blockNumber,
      blockHash: native.blockHash,
    });
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

// Phase 5.12: the enum-typed twin of priceSourceForTokens above, for
// historicalObservations.priceLabel (schema.ts, "ONCHAIN_NATIVE" |
// "EXTERNAL_FALLBACK" | "HYBRID") - a column that has existed since Phase
// 5.3 but was never actually written for pool/vault tvl_usd rows (every
// pre-Phase-5.12 row has it NULL; only the token price-observation and
// volume-engine writers ever populated it). Deliberately the SAME
// native/hybrid/external classification as priceSourceForTokens, computed
// from the exact same two inputs, rather than re-deriving it from the
// free-text priceSource string that function returns - parsing "hybrid:"
// back out of a string built for a debug/display label would couple two
// independent concerns for no reason when the real classification is a
// two-line pure function.
//
// `tokenKeys` uses whichever identity each token was actually priced by
// (coingeckoId for a curated VERIFIED_POOLS token, on-chain address for a
// discovered-pool token with no coingeckoId - see
// HistoricalObservationCalculationInput's own comment, schema.ts) - the
// caller passes the SAME keys it used to build both `priceById` and
// `nativelyPricedKeys`, so this never needs to know which identity scheme a
// given pool uses.
export function priceLabelForTokens(tokenKeys: readonly string[], nativelyPricedKeys: ReadonlySet<string>): "ONCHAIN_NATIVE" | "EXTERNAL_FALLBACK" | "HYBRID" {
  if (tokenKeys.length === 0) return "EXTERNAL_FALLBACK";
  const allNative = tokenKeys.every((key) => nativelyPricedKeys.has(key));
  if (allNative) return "ONCHAIN_NATIVE";
  const someNative = tokenKeys.some((key) => nativelyPricedKeys.has(key));
  return someNative ? "HYBRID" : "EXTERNAL_FALLBACK";
}
