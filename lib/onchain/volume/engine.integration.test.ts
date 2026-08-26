// Real-Postgres integration test for indexAllPoolVolume's multi-pool
// isolation (Section 30/31) - a broken pool must not prevent the loop from
// reaching/reporting on the next one. Deliberately scoped to the
// deterministic, RPC-free early-exit paths (chain/pool not found in the
// DB) rather than a full live-RPC scenario - engine.ts's own module
// convention is "RPC-touching orchestration is not unit-tested directly,
// only its extracted pure decision functions are" (see effectiveStartBlock
// in engine.test.ts), and indexPoolVolume's chain/pool identity lookups
// (getChainId/getPoolIdByConfigKey) are real DB reads that need no
// mocking to exercise this specific isolation guarantee.
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/database/client";
import type { VolumeSourcePool } from "./config";
import { indexAllPoolVolume } from "./engine";

function unresolvablePool(key: string): VolumeSourcePool {
  return {
    key,
    chainSlug: `nonexistent-chain-${key}`,
    poolAddress: "0xpool",
    sourceKind: "uniswap-v2",
    token0: { address: "0xusdc", symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
    token1: { address: "0xweth", symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    factoryAddress: "0xfactory",
    feeBps: 30,
    feeVerification: "test",
    startBlock: BigInt(1),
  };
}

describe("indexAllPoolVolume - multi-pool isolation", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("continues to the next pool after an earlier one fails - both failures are reported, not just the first", async () => {
    const poolA = unresolvablePool("isolation-test-pool-a");
    const poolB = unresolvablePool("isolation-test-pool-b");

    const results = await indexAllPoolVolume([poolA, poolB]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ poolKey: poolA.key, ok: false, outcome: "failed" });
    expect(results[1]).toMatchObject({ poolKey: poolB.key, ok: false, outcome: "failed" });
    // Each pool's own error message is independent - proves poolB was
    // actually attempted with its own identity, not skipped or a copy of
    // poolA's failure.
    expect(results[0].error).toContain(poolA.chainSlug);
    expect(results[1].error).toContain(poolB.chainSlug);
  });

  it("never lets one pool's result carry another pool's chunk data (result isolation)", async () => {
    const poolA = unresolvablePool("isolation-test-pool-c");
    const poolB = unresolvablePool("isolation-test-pool-d");

    const results = await indexAllPoolVolume([poolA, poolB]);

    for (const result of results) {
      expect(result.chunks).toEqual([]);
      expect(result.chunksCompleted).toBe(0);
    }
  });
});
