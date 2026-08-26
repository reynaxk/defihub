import { formatUnits, parseUnits } from "viem";
import type { AggregatedPriceResult, CandidatePriceSource, PriceConfidence, PriceLabel, PriceSourceObservation } from "./types";

// Centralized, documented thresholds - see task requirement "centralize
// configuration... document why each threshold exists" (this module's own
// header). Every one of these is a deliberate, named policy decision, not a
// magic number scattered inline.
export const PRICING_THRESHOLDS = {
  // A pool below this USD depth is rejected as a price source outright
  // (enforced in uniswap-v2.ts's deriveV2Price, not here) - a thin pool is
  // both easy to manipulate (a modest trade moves its price a lot) and an
  // imprecise ratio (rounding in low-reserve integers). $10k is a
  // conservative floor for a REFERENCE asset specifically (stablecoins,
  // ETH, BTC) - real reference pools this phase actually uses (see
  // config.ts) are all multiple orders of magnitude above this in practice;
  // the floor exists to make a misconfigured/decayed pool fail loudly
  // rather than silently produce a price from an effectively-empty pool.
  MIN_LIQUIDITY_USD: "10000",
  // A source's included liquidity must reach this before its price alone
  // (or its agreement with other sources) can earn HIGH/MEDIUM confidence -
  // see classifyConfidence. Set well above MIN_LIQUIDITY_USD: clearing the
  // bare minimum to be considered at all is not the same bar as being
  // "comfortably" liquid enough to trust as a primary price.
  COMFORTABLE_LIQUIDITY_USD: "250000",
  // A candidate source whose derived price deviates from the cross-source
  // median by more than this is rejected as an outlier - it disagrees with
  // the group enough that it's more likely wrong (stale, manipulated, or a
  // decoding bug) than that every other source is. 500 bps (5%) is
  // deliberately loose relative to a typical liquid-market bid/ask spread -
  // the goal is catching a genuinely broken/manipulated source, not
  // penalizing ordinary cross-pool spread.
  MAX_DEVIATION_FROM_MEDIAN_BPS: BigInt(500),
  // A source whose own observation is older than this relative to the
  // current pricing run is excluded as stale, never blended in as if it
  // were fresh. In this phase's actual runtime usage every source is read
  // in the same pinned per-chain multicall as every other (see engine.ts),
  // so observedAt is always "now" in practice - this check is real,
  // deterministic, and tested (see aggregate.test.ts) as a defensive
  // safeguard for any future source kind that might legitimately carry an
  // older observation (e.g. a slower-updating feed), not a mechanism this
  // phase's own V2 adapter ever actually triggers.
  MAX_SOURCE_AGE_MS: 5 * 60 * 1000,
  // The bar for HIGH confidence: 2+ sources, comfortably liquid, agreeing
  // within this tight a band. Deliberately much tighter than the outlier-
  // rejection threshold above - "not an outlier" (didn't get thrown out) is
  // a much lower bar than "genuinely corroborating" (close enough to treat
  // as independent confirmation of the same real price).
  HIGH_CONFIDENCE_AGREEMENT_BPS: BigInt(100),
  // A DIFFERENT concern from MAX_SOURCE_AGE_MS above: that one bounds how
  // old a single source's read can be WITHIN one aggregation pass (always
  // ~0 in practice, since every source is read in the same pinned
  // multicall - see that constant's own comment). This one bounds how old
  // an already-PERSISTED native price observation can be before it's still
  // eligible to override an external fallback price for TVL computation
  // "right now" (lib/onchain/pricing/tvl-integration.ts) - a genuinely
  // different question, asked at read time, potentially long after the
  // observation was written. The on-chain pricing cron runs every 30
  // minutes (vercel.json's "/api/cron/price-onchain" schedule) - twice
  // that interval tolerates exactly one missed/delayed run without
  // treating a merely-late price as untrustworthy, while still rejecting a
  // price from a cron that's been silently broken for longer than that.
  // Confidence alone (HIGH/MEDIUM) says nothing about *when* a price was
  // observed - a high-confidence price from hours ago is not automatically
  // still correct.
  MAX_NATIVE_PRICE_AGE_FOR_TVL_MS: 60 * 60 * 1000,
} as const;

function toScaledBigInt(decimal: string, scale = 30): bigint {
  return parseUnits(decimal, scale);
}

// Exact BigInt deviation in basis points of `price` from `reference` -
// |price - reference| / reference * 10000, rounded down. Never floating
// point: two exact decimal strings in, one exact integer (bps) out.
function deviationBps(price: string, reference: string): bigint {
  const priceScaled = toScaledBigInt(price);
  const referenceScaled = toScaledBigInt(reference);
  if (referenceScaled === BigInt(0)) return BigInt(0); // degenerate - only reachable if a $0 reference ever got this far, which callers reject earlier
  const diff = priceScaled > referenceScaled ? priceScaled - referenceScaled : referenceScaled - priceScaled;
  return (diff * BigInt(10000)) / referenceScaled;
}

// Median of a set of exact decimal-string prices, itself returned as an
// exact decimal string. Even-length sets average the two middle values
// (exact BigInt division, not floating point) - the standard definition,
// not an approximation.
export function medianPrice(prices: string[]): string {
  const scaled = prices.map((p) => toScaledBigInt(p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(scaled.length / 2);
  const medianScaled = scaled.length % 2 === 1 ? scaled[mid] : (scaled[mid - 1] + scaled[mid]) / BigInt(2);
  return formatUnits(medianScaled, 30);
}

export interface AggregationInput {
  candidate: CandidatePriceSource;
  observedAt: Date;
}

// Pure - the full staleness -> outlier -> confidence pipeline, directly
// unit-testable with synthetic candidates and no RPC involved. `now` is
// injected (not `new Date()` internally) so staleness is deterministically
// testable without faking the system clock.
export function aggregatePrices(inputs: AggregationInput[], now: Date, label: PriceLabel = "ONCHAIN_NATIVE"): AggregatedPriceResult {
  const sources: PriceSourceObservation[] = [];

  // Pass 1: staleness. Evaluated first and independently of the other
  // candidates - whether a source is too old to trust doesn't depend on
  // what any other source says.
  const fresh: AggregationInput[] = [];
  for (const input of inputs) {
    const ageMs = now.getTime() - input.observedAt.getTime();
    if (ageMs > PRICING_THRESHOLDS.MAX_SOURCE_AGE_MS) {
      sources.push({ ...input.candidate, included: false, exclusionReason: `stale: observed ${ageMs}ms ago, exceeding the ${PRICING_THRESHOLDS.MAX_SOURCE_AGE_MS}ms limit` });
    } else {
      fresh.push(input);
    }
  }

  // Pass 2: outlier rejection against the median of the still-fresh
  // candidates. A single fresh candidate is its own median (deviation 0),
  // so it's never rejected as an outlier purely for being alone - see
  // classifyConfidence below for how source count on its own still bounds
  // the resulting confidence.
  const freshPrices = fresh.map((f) => f.candidate.priceUsd);
  const median = freshPrices.length > 0 ? medianPrice(freshPrices) : null;

  const included: AggregationInput[] = [];
  for (const input of fresh) {
    const deviation = median != null ? deviationBps(input.candidate.priceUsd, median) : BigInt(0);
    if (median != null && deviation > PRICING_THRESHOLDS.MAX_DEVIATION_FROM_MEDIAN_BPS) {
      sources.push({
        ...input.candidate,
        included: false,
        exclusionReason: `outlier: ${deviation}bps from the ${fresh.length}-source median ($${median}), exceeding the ${PRICING_THRESHOLDS.MAX_DEVIATION_FROM_MEDIAN_BPS}bps limit`,
      });
    } else {
      included.push(input);
    }
  }

  if (included.length === 0) {
    return { priceUsd: "0", confidence: "INVALID", label, sources };
  }

  // Pass 3: zero-liquidity guard. deriveV2Price's own MIN_LIQUIDITY_USD
  // floor (uniswap-v2.ts) already rejects a thin pool before it ever
  // becomes a candidate at all - this is a defensive floor for any future
  // source kind that might not enforce an equivalent minimum. A candidate
  // with exactly zero liquidity can never contribute a defined weight to
  // the liquidity-weighted mean below; dividing by a totalLiquidity of
  // exactly zero would throw, not silently produce a fabricated price.
  // Excluded the same way stale/outlier candidates are, with its own
  // reason - never silently dropped from provenance.
  const weighted: AggregationInput[] = [];
  for (const input of included) {
    if (toScaledBigInt(input.candidate.liquidityUsd) === BigInt(0)) {
      sources.push({ ...input.candidate, included: false, exclusionReason: "zero liquidity - cannot contribute to a liquidity-weighted price" });
    } else {
      weighted.push(input);
    }
  }

  if (weighted.length === 0) {
    return { priceUsd: "0", confidence: "INVALID", label, sources };
  }

  // Liquidity-weighted mean of the surviving sources - a deeper pool's
  // price is weighted more heavily than a shallow one, rather than a naive
  // average that would let a thin, easily-moved pool count exactly as much
  // as a deep one. Exact BigInt arithmetic throughout: each source's
  // contribution is (price * liquidity), summed and divided by total
  // liquidity, all at CALCULATION_SCALE fixed point. totalLiquidity is
  // guaranteed positive here - every zero-liquidity candidate was already
  // excluded above.
  const SCALE = 30;
  const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);
  let weightedSum = BigInt(0);
  let totalLiquidity = BigInt(0);
  for (const input of weighted) {
    const priceScaled = toScaledBigInt(input.candidate.priceUsd, SCALE);
    const liquidityScaled = toScaledBigInt(input.candidate.liquidityUsd, SCALE);
    weightedSum += (priceScaled * liquidityScaled) / SCALE_FACTOR;
    totalLiquidity += liquidityScaled;
  }
  const priceUsd = formatUnits((weightedSum * SCALE_FACTOR) / totalLiquidity, SCALE);

  for (const input of weighted) {
    sources.push({ ...input.candidate, included: true });
  }

  const confidence = classifyConfidence(weighted.map((i) => i.candidate), label);
  return { priceUsd, confidence, label, sources };
}

// Deterministic confidence classification - see PRICING_THRESHOLDS above for
// every number this depends on, each with its own documented reason.
// Explicitly NOT a model of any kind: a fixed decision tree over source
// count, total included liquidity, and cross-source agreement.
export function classifyConfidence(includedSources: CandidatePriceSource[], label: PriceLabel): PriceConfidence {
  if (includedSources.length === 0) return "INVALID";

  // An external-fallback price was never independently corroborated by
  // this engine's own on-chain reads - capped at MEDIUM regardless of how
  // many sources CoinGecko itself blends internally, since this engine has
  // no visibility into (or control over) that.
  const ceiling: PriceConfidence = label === "EXTERNAL_FALLBACK" ? "MEDIUM" : "HIGH";

  const totalLiquidityScaled = includedSources.reduce((sum, s) => sum + toScaledBigInt(s.liquidityUsd), BigInt(0));
  const comfortableLiquidityScaled = toScaledBigInt(PRICING_THRESHOLDS.COMFORTABLE_LIQUIDITY_USD);
  const hasComfortableLiquidity = totalLiquidityScaled >= comfortableLiquidityScaled;

  if (!hasComfortableLiquidity) return "LOW";

  if (includedSources.length === 1) {
    // A single, comfortably-liquid, uncorroborated source - real and
    // trustworthy enough to use, but never HIGH on its own: HIGH requires
    // genuine independent agreement (see below), which one source alone
    // cannot demonstrate.
    return downgrade("MEDIUM", ceiling);
  }

  const prices = includedSources.map((s) => s.priceUsd);
  const median = medianPrice(prices);
  const maxDeviation = prices.reduce((max, p) => {
    const d = deviationBps(p, median);
    return d > max ? d : max;
  }, BigInt(0));

  if (maxDeviation <= PRICING_THRESHOLDS.HIGH_CONFIDENCE_AGREEMENT_BPS) return downgrade("HIGH", ceiling);
  return downgrade("MEDIUM", ceiling);
}

const CONFIDENCE_RANK: Record<PriceConfidence, number> = { INVALID: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
function downgrade(level: PriceConfidence, ceiling: PriceConfidence): PriceConfidence {
  return CONFIDENCE_RANK[level] <= CONFIDENCE_RANK[ceiling] ? level : ceiling;
}
