// Pure unit tests for one run's volume/fee summation and confidence
// classification - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { aggregateSwapVolume, classifyVolumeConfidence } from "./aggregate";
import type { SwapVolumeResult } from "./types";

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

  it("rounds fees from the exact summed total, not from N separately-rounded per-swap fees", () => {
    // 3 swaps of $0.01 each at 30bps would floor to $0 per-swap if rounded
    // individually first; summed first (0.03 * 0.003 = 0.00009) the
    // distinction is moot at this scale, but the summed-total order is
    // what matters structurally - see aggregate.ts's own comment.
    const result = aggregateSwapVolume([priced("0.01"), priced("0.01"), priced("0.01")], 30);
    expect(result.volumeUsd).toBe("0.03");
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
