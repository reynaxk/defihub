// Pure unit tests for one run's volume/fee summation and confidence
// classification - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { aggregateSwapVolume, classifyVolumeConfidence } from "./aggregate";
import type { SwapVolumeResult } from "./types";
import { computeSwapFeeUsd } from "./uniswap-v2";

function priced(volumeUsd: string): SwapVolumeResult {
  return { ok: true, volumeUsd, pricedSides: [] };
}
function unpriced(error = "missing USD price for token1"): SwapVolumeResult {
  return { ok: false, error };
}

describe("aggregateSwapVolume", () => {
  it("sums a single priced swap and applies the pool's own fee bps", () => {
    const result = aggregateSwapVolume([priced("100")], 30);
    expect(result).toEqual({ volumeUsd: "100", feesUsd: "0.3", swapCount: 1, pricedSwapCount: 1, unpricedSwapCount: 0 });
  });

  it("sums multiple priced swaps across multiple blocks", () => {
    const result = aggregateSwapVolume([priced("100"), priced("250.5"), priced("49.5")], 30);
    expect(result.volumeUsd).toBe("400");
    expect(result.swapCount).toBe(3);
    expect(result.pricedSwapCount).toBe(3);
  });

  it("correctly combines a large, multi-chunk-sized batch of swaps into one total - proving every swap contributes regardless of how many eth_getLogs chunks originally produced them", () => {
    // scanBlockRange (lib/indexing/events.ts) issues one eth_getLogs call
    // per chunk internally but returns every chunk's logs already merged
    // into a single array - engine.ts's processSwapLogs (and therefore
    // this function) only ever sees that one combined batch, never a
    // per-chunk slice (see engine.ts's own comment on why there is no
    // separate per-chunk callback to accumulate across). This test proves
    // the actual data flow works end to end at the volume: a batch far
    // larger than this indexer's own DEFAULT_VOLUME_CHUNK_SIZE (50) -
    // exactly what a first run after a long gap, spanning several chunks,
    // would hand to this function in one call - still sums to the exact
    // correct total, with every single swap counted exactly once.
    const swaps = Array.from({ length: 237 }, () => priced("1.5"));
    const result = aggregateSwapVolume(swaps, 30);
    expect(result.volumeUsd).toBe("355.5"); // 237 * 1.5
    expect(result.swapCount).toBe(237);
    expect(result.pricedSwapCount).toBe(237);
    expect(result.unpricedSwapCount).toBe(0);
  });

  it("excludes unpriced swaps from volumeUsd entirely - never treats a missing price as $0", () => {
    const result = aggregateSwapVolume([priced("100"), unpriced(), priced("50")], 30);
    expect(result.volumeUsd).toBe("150");
    expect(result.swapCount).toBe(3);
    expect(result.pricedSwapCount).toBe(2);
    expect(result.unpricedSwapCount).toBe(1);
  });

  it("returns all-zero for an empty batch, never throwing", () => {
    const result = aggregateSwapVolume([], 30);
    expect(result).toEqual({ volumeUsd: "0", feesUsd: "0", swapCount: 0, pricedSwapCount: 0, unpricedSwapCount: 0 });
  });

  it("returns all-zero when every swap in the batch was unpriced", () => {
    const result = aggregateSwapVolume([unpriced(), unpriced()], 30);
    expect(result.volumeUsd).toBe("0");
    expect(result.unpricedSwapCount).toBe(2);
    expect(result.pricedSwapCount).toBe(0);
  });

  it("rounds fees from the exact summed total, not from N separately-rounded per-swap fees - a case where the two approaches actually diverge", () => {
    // At CALCULATION_SCALE=30 and feeBps=30 (rate 30/10000), a volume value
    // of exactly 333 units (at the 30-decimal scale) produces a per-swap
    // fee of floor(333 * 30 / 10000) = floor(9990/10000) = 0 - the fee is
    // truncated away entirely for EACH swap individually. Summed first,
    // the combined volume is 666 units: floor(666 * 30 / 10000) =
    // floor(19980/10000) = 1 - a real, nonzero fee. This is not a
    // contrived edge case with no bearing on production: the fee-then-sum
    // approach would silently drop real trading fee revenue that
    // aggregate-first correctly captures, for ANY pair of swap volumes
    // whose individual remainders (volume*feeBps mod 10000) sum past
    // 10000 - verified live against these exact production functions
    // (computeSwapFeeUsd/aggregateSwapVolume) before writing this test.
    const a = "0.000000000000000000000000000333";
    const b = "0.000000000000000000000000000333";

    // The WRONG approach this test guards against: computing each swap's
    // fee individually and summing those (never actually done by
    // aggregateSwapVolume - this is here only to prove the two approaches
    // really do diverge for these inputs, making the assertion below
    // meaningful rather than vacuous).
    const wrongPerSwapThenSum = BigInt(computeSwapFeeUsd(a, 30).replace(".", "")) + BigInt(computeSwapFeeUsd(b, 30).replace(".", ""));
    expect(wrongPerSwapThenSum).toBe(BigInt(0));

    const result = aggregateSwapVolume([priced(a), priced(b)], 30);
    expect(result.volumeUsd).toBe("0.000000000000000000000000000666");
    // Aggregate-first correctly produces a nonzero fee here - the exact
    // number the naive per-swap approach above would have missed entirely.
    expect(result.feesUsd).toBe("0.000000000000000000000000000001");
  });

  it("rounds fees from the exact summed total for a simpler, human-scale case too", () => {
    // 3 swaps of $0.01 each at 30bps - at this precision the two
    // approaches happen to agree (see the boundary-case test above for
    // where they genuinely diverge), so this test exists purely to prove
    // ordinary, realistic volumes still sum and fee correctly.
    const result = aggregateSwapVolume([priced("0.01"), priced("0.01"), priced("0.01")], 30);
    expect(result.volumeUsd).toBe("0.03");
    expect(result.feesUsd).toBe("0.00009");
  });
});

describe("classifyVolumeConfidence", () => {
  it("is HIGH when every swap this run priced cleanly", () => {
    expect(classifyVolumeConfidence(5, 0)).toBe("HIGH");
  });
  it("is MEDIUM when some priced and some didn't", () => {
    expect(classifyVolumeConfidence(3, 2)).toBe("MEDIUM");
  });
  it("is LOW when nothing could be priced", () => {
    expect(classifyVolumeConfidence(0, 4)).toBe("LOW");
  });
});
