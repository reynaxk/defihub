import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, tokens, type PriceSourceObservation } from "@/lib/database/schema";
import { PRICING_THRESHOLDS } from "./aggregate";
import type { PriceConfidence, PriceLabel } from "./types";

export interface NativeTokenPrice {
  priceUsd: string;
  confidence: PriceConfidence;
  label: PriceLabel;
  blockNumber: number | null;
  blockHash: string | null;
  observedAt: Date;
  sources: PriceSourceObservation[];
}

// The latest still-canonical (reorgInvalidatedAt IS NULL) native price for
// one token, or null if this engine has never priced it. Reads
// historicalObservations directly rather than through any "latest value"
// cache table - see record-price-observation.ts's own module comment for
// why none exists for prices - using the exact same
// historical_observations_entity_idx (entityType, entityId, metric,
// timestamp) index every other "give me the latest observation for this
// entity" query in this app already relies on.
export async function getNativeTokenPrice(chainSlug: string, address: string): Promise<NativeTokenPrice | null> {
  const [row] = await db
    .select({
      value: historicalObservations.value,
      confidence: historicalObservations.confidence,
      priceLabel: historicalObservations.priceLabel,
      blockNumber: historicalObservations.blockNumber,
      blockHash: historicalObservations.blockHash,
      timestamp: historicalObservations.timestamp,
      calculationInputs: historicalObservations.calculationInputs,
    })
    .from(historicalObservations)
    .innerJoin(tokens, eq(tokens.id, historicalObservations.entityId))
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(
      and(
        eq(chains.slug, chainSlug),
        eq(tokens.address, address.toLowerCase()),
        eq(historicalObservations.entityType, "token"),
        eq(historicalObservations.metric, "price_usd"),
        isNull(historicalObservations.reorgInvalidatedAt),
      ),
    )
    .orderBy(desc(historicalObservations.timestamp))
    .limit(1);

  if (!row || row.confidence == null || row.priceLabel == null) return null;

  return {
    priceUsd: row.value,
    confidence: row.confidence as PriceConfidence,
    label: row.priceLabel as PriceLabel,
    blockNumber: row.blockNumber != null ? Number(row.blockNumber) : null,
    blockHash: row.blockHash,
    observedAt: row.timestamp,
    // entityType is filtered to "token" above - calculationInputs here is
    // always the PriceSourceObservation[] shape (see schema.ts's own
    // comment on why the column allows two shapes).
    sources: (row.calculationInputs as PriceSourceObservation[] | null) ?? [],
  };
}

// Whether a native token price is recent enough to still be trusted for a
// decision made "right now" (e.g. lib/onchain/pricing/tvl-integration.ts's
// TVL override, via isNativePriceEligibleForTvl there - which delegates to
// this exact function rather than re-implementing its own freshness check,
// so both callers stay consistent by construction, not by convention) - a
// genuinely different question from confidence, which says how
// *well-corroborated* a price was at observation time, not how long ago
// that was. Deliberately keyed off the observation's own `observedAt`
// timestamp, never blockNumber: block numbers aren't comparable across
// chains and don't map to wall-clock time at all, so they can't answer "is
// this too old to use right now." `now` is injected (not `new Date()`
// internally) so this stays deterministically testable without faking the
// system clock - the same convention aggregate.ts's aggregatePrices
// already established for its own staleness check.
export function isNativeTokenPriceFresh(observedAt: Date, now: Date): boolean {
  const ageMs = now.getTime() - observedAt.getTime();
  // A negative age means observedAt is in the future relative to now - a
  // corrupted or clock-skewed timestamp, never a legitimately "extra
  // fresh" observation. Rejected explicitly: a negative number is always
  // <= a positive MAX_NATIVE_PRICE_AGE_FOR_TVL_MS threshold, so without
  // this check every future-dated observation would pass the age
  // comparison below and be treated as maximally fresh - exactly
  // backwards. This is a current-price eligibility check only - it never
  // touches, deletes, or invalidates the underlying historical_observations
  // row, and it makes no claim about why the timestamp is wrong.
  if (ageMs < 0) return false;
  return ageMs <= PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS;
}
