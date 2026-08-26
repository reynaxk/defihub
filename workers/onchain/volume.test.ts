// Pure unit test for summarizeVolumeResults - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { summarizeVolumeResults } from "./volume";
import type { PoolVolumeRunResult } from "../../lib/onchain/volume/engine";

function ok(overrides: Partial<PoolVolumeRunResult> = {}): PoolVolumeRunResult {
  return { poolKey: "test-pool", ok: true, swapCount: 5, ...overrides };
}
function failed(error = "rpc down"): PoolVolumeRunResult {
  return { poolKey: "test-pool", ok: false, error };
}

describe("summarizeVolumeResults", () => {
  it("reports success when every configured pool indexed cleanly", () => {
    const summary = summarizeVolumeResults([ok({ swapCount: 3 }), ok({ swapCount: 7 })]);
    expect(summary).toEqual({ succeeded: 2, failed: 0, totalSwaps: 10, outcome: "success" });
  });

  it("reports partial when any pool failed outright, without discarding the successful pools' counts", () => {
    const summary = summarizeVolumeResults([ok({ swapCount: 3 }), failed()]);
    expect(summary).toEqual({ succeeded: 1, failed: 1, totalSwaps: 3, outcome: "partial" });
  });

  it("treats a zero-swap successful run as success, not a failure", () => {
    const summary = summarizeVolumeResults([ok({ swapCount: 0 })]);
    expect(summary).toEqual({ succeeded: 1, failed: 0, totalSwaps: 0, outcome: "success" });
  });

  it("reports success for an empty result set (no pools configured)", () => {
    expect(summarizeVolumeResults([])).toEqual({ succeeded: 0, failed: 0, totalSwaps: 0, outcome: "success" });
  });
});
