import { formatUnits, parseUnits } from "viem";
import { computeSwapFeeUsd } from "./uniswap-v2";
import type { SwapVolumeResult } from "./types";

const CALCULATION_SCALE = 30;

export interface VolumeAggregateResult {
  volumeUsd: string;
  feesUsd: string;
  swapCount: number;
  pricedSwapCount: number;
  unpricedSwapCount: number;
}

// Pure - sums one indexing run's already-priced swaps into a single
// volume/fee total, directly unit-testable with plain constructed
// SwapVolumeResult values, no RPC/DB involved. An unpriced swap (`ok:
// false`) contributes to `unpricedSwapCount` but NOT to `volumeUsd` -
// never silently treated as $0 (Phase 5.4's own "partial data" rule) - the
// caller (engine.ts) uses `unpricedSwapCount` to decide whether this run's
// observation should be marked partial/degraded rather than fully
// confident. Fees are derived from the summed volume, not summed
// per-swap-then-rounded, to avoid accumulating N separate rounding errors
// across a whole run - the exact same "round once, from the exact total"
// discipline verify-pool.ts's own roundExactDecimal usage already
// establishes.
export function aggregateSwapVolume(volumeResults: SwapVolumeResult[], feeBps: number): VolumeAggregateResult {
  let totalVolumeAtScale = BigInt(0);
  let pricedSwapCount = 0;
  let unpricedSwapCount = 0;

  for (const result of volumeResults) {
    if (result.ok) {
      totalVolumeAtScale += parseUnits(result.volumeUsd, CALCULATION_SCALE);
      pricedSwapCount++;
    } else {
      unpricedSwapCount++;
    }
  }

  const volumeUsd = formatUnits(totalVolumeAtScale, CALCULATION_SCALE);
  const feesUsd = computeSwapFeeUsd(volumeUsd, feeBps);

  return {
    volumeUsd,
    feesUsd,
    swapCount: volumeResults.length,
    pricedSwapCount,
    unpricedSwapCount,
  };
}

// Pure - repurposes historicalObservations' existing `confidence` column
// (originally Phase 5.3's price-corroboration signal, see its own
// schema.ts comment) for this metric family: how much of THIS run's
// volume figure actually reflects priced swaps, versus swaps that had to
// be excluded for lack of a usable token price (Section 22's "never
// silently zero a missing price" - an unpriced swap contributes to
// unpricedSwapCount, never to volumeUsd, so a run with many unpriced
// swaps produces a real but knowingly-incomplete number). Never called for
// a zero-swap run (engine.ts skips writing an observation entirely in
// that case - see its own comment for why).
export function classifyVolumeConfidence(pricedSwapCount: number, unpricedSwapCount: number): "HIGH" | "MEDIUM" | "LOW" {
  if (unpricedSwapCount === 0) return "HIGH";
  if (pricedSwapCount === 0) return "LOW";
  return "MEDIUM";
}
