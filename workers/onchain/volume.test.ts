// Pure unit test for summarizeVolumeResults - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { summarizeVolumeResults } from "./volume";
import type { ChunkVolumeResult, PoolVolumeRunResult } from "../../lib/onchain/volume/engine";

function chunk(overrides: Partial<ChunkVolumeResult> = {}): ChunkVolumeResult {
  return { fromBlock: "100", toBlock: "150", swapCount: 3, pricedSwapCount: 3, unpricedSwapCount: 0, ...overrides };
}

function success(overrides: Partial<PoolVolumeRunResult> = {}): PoolVolumeRunResult {
  return {
    poolKey: "test-pool",
    ok: true,
    outcome: "success",
    chunks: [chunk()],
    chunksCompleted: 1,
    chunksAttempted: 1,
    safeHead: "1000",
    cursorAfterRun: "1000",
    lag: "0",
    ...overrides,
  };
}

function partial(overrides: Partial<PoolVolumeRunResult> = {}): PoolVolumeRunResult {
  return {
    poolKey: "test-pool",
    ok: true,
    outcome: "partial",
    chunks: [chunk(), chunk({ fromBlock: "151", toBlock: "200" })],
    chunksCompleted: 2,
    chunksAttempted: 3,
    stoppedReason: "range-limit-at-minimum-chunk-size",
    safeHead: "1000",
    cursorAfterRun: "200",
    lag: "800",
    ...overrides,
  };
}

function failed(overrides: Partial<PoolVolumeRunResult> = {}): PoolVolumeRunResult {
  return { poolKey: "test-pool", ok: false, outcome: "failed", error: "rpc down", chunks: [], chunksCompleted: 0, chunksAttempted: 0, ...overrides };
}

describe("summarizeVolumeResults", () => {
  it("reports success when every configured pool fully caught up", () => {
    const summary = summarizeVolumeResults([success(), success()]);
    expect(summary).toEqual({ succeeded: 2, partial: 0, failed: 0, totalSwaps: 6, outcome: "success" });
  });

  it("reports partial when a pool made real but incomplete catch-up progress", () => {
    const summary = summarizeVolumeResults([success(), partial()]);
    expect(summary.outcome).toBe("partial");
    expect(summary.succeeded).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.totalSwaps).toBe(3 + 6); // success's 1 chunk (3) + partial's 2 chunks (3 each)
  });

  it("reports partial (not failed) when one pool fails outright but another succeeds - multi-pool isolation", () => {
    const summary = summarizeVolumeResults([success(), failed()]);
    expect(summary.outcome).toBe("partial");
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("reports failed only when NOTHING succeeded anywhere", () => {
    const summary = summarizeVolumeResults([failed(), failed()]);
    expect(summary).toEqual({ succeeded: 0, partial: 0, failed: 2, totalSwaps: 0, outcome: "failed" });
  });

  it("treats a zero-swap successful run as success, not a failure", () => {
    const summary = summarizeVolumeResults([success({ chunks: [chunk({ swapCount: 0, pricedSwapCount: 0 })] })]);
    expect(summary.outcome).toBe("success");
    expect(summary.totalSwaps).toBe(0);
  });

  it("reports success for an empty result set (no pools configured)", () => {
    expect(summarizeVolumeResults([])).toEqual({ succeeded: 0, partial: 0, failed: 0, totalSwaps: 0, outcome: "success" });
  });

  it("sums swap counts across every chunk of every pool, not just the first chunk", () => {
    const manyChunks = success({ chunks: [chunk({ swapCount: 10 }), chunk({ swapCount: 20 }), chunk({ swapCount: 5 })], chunksCompleted: 3 });
    const summary = summarizeVolumeResults([manyChunks]);
    expect(summary.totalSwaps).toBe(35);
  });
});
