// Pure unit tests for summarizePriceResults - the deterministic accounting
// rule deciding a pricing run's overall priced/skipped/failed counts and
// success/partial classification. priceOnchain/priceAllReferenceAssets
// themselves are not unit-tested here (RPC/DB-touching orchestration),
// matching this codebase's established convention.
import { describe, expect, it } from "vitest";
import { summarizePriceResults } from "./price";
import type { ReferenceAssetPriceResult } from "@/lib/onchain/pricing/price-reference-assets";

function result(key: string, outcome: ReferenceAssetPriceResult["outcome"], error?: string): ReferenceAssetPriceResult {
  return { key, outcome, error };
}

describe("summarizePriceResults", () => {
  it("reports success when every requested asset actually persisted - preserves existing successful-run behavior", () => {
    const results = [result("usdc-ethereum", "written"), result("weth-ethereum", "written")];
    const summary = summarizePriceResults(results);
    expect(summary).toEqual({ priced: 2, skipped: 0, failed: 0, outcome: "success" });
  });

  it("counts a skipped-no-token outcome as skipped, never as priced, and reports the run as partial", () => {
    const results = [result("usdc-ethereum", "written"), result("weth-ethereum", "skipped-no-token")];
    const summary = summarizePriceResults(results);
    expect(summary.priced).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.outcome).toBe("partial");
  });

  it("counts a skipped-invalid-hash outcome as skipped, never as priced, and reports the run as partial", () => {
    const results = [result("usdc-ethereum", "written"), result("weth-ethereum", "skipped-invalid-hash")];
    const summary = summarizePriceResults(results);
    expect(summary.priced).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.outcome).toBe("partial");
  });

  it("reports partial for a mix of successful and skipped assets", () => {
    const results = [
      result("usdc-ethereum", "written"),
      result("weth-ethereum", "written"),
      result("usdt-ethereum", "skipped-no-token"),
      result("dai-ethereum", "skipped-invalid-hash"),
    ];
    const summary = summarizePriceResults(results);
    expect(summary.priced).toBe(2);
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.outcome).toBe("partial");
  });

  it("reports partial with zero priced when every asset is skipped - never classified as success just because nothing threw", () => {
    const results = [
      result("usdc-ethereum", "skipped-no-token"),
      result("weth-ethereum", "skipped-invalid-hash"),
      result("usdt-ethereum", "skipped-no-token"),
    ];
    const summary = summarizePriceResults(results);
    expect(summary.priced).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.outcome).toBe("partial");
  });

  it("counts a failed outcome (chain read error, dependency failure, DB error) separately from skipped, and still reports partial", () => {
    const results = [result("usdc-ethereum", "written"), result("weth-ethereum", "failed", "chain read failed")];
    const summary = summarizePriceResults(results);
    expect(summary.priced).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.outcome).toBe("partial");
  });

  it("reports success for zero requested assets, matching priceAllReferenceAssets' own empty-config short-circuit", () => {
    const summary = summarizePriceResults([]);
    expect(summary).toEqual({ priced: 0, skipped: 0, failed: 0, outcome: "success" });
  });
});
