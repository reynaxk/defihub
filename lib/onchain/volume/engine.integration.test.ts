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
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { indexingState } from "@/lib/database/schema";
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

// Phase 5.10: indexAllPoolVolume now persists/advances a rotation cursor
// (see engine.ts's own PRIORITY_BATCH_SIZE/POOL_ROTATION_* comment) under
// a real, shared, un-namespaced production key by default - EVERY test in
// this file that calls indexAllPoolVolume must inject a disposable,
// randomized rotationCursorKey instead, the same discipline
// volume/reorg.ts's own VolumeReorgRecheckOptions.rotationCursorKey
// already established. Omitting this (as this file's own two pre-existing
// isolation tests originally did) silently advances the REAL production
// rotation cursor on every test run - caught live during this phase's own
// development (the real cursor's offset had drifted to a value that only
// made sense as "test suite run count x 2 pools x 2 call sites", not any
// real production indexing activity).
const createdRotationComponents: string[] = [];
function rotationCursorKey(): { chainSlug: string; component: string } {
  const component = `test-volume-rotation-${randomUUID()}`;
  createdRotationComponents.push(component);
  return { chainSlug: "test-volume-rotation-global", component };
}

describe("indexAllPoolVolume - multi-pool isolation", () => {
  afterEach(async () => {
    for (const component of createdRotationComponents.splice(0)) await db.delete(indexingState).where(eq(indexingState.component, component));
  });

  // closeDb() lives ONLY in the LAST describe block of this file (below) -
  // vitest runs describe blocks in this file sequentially, so calling it
  // here too would close the shared db client before the next describe
  // block's own tests ever ran.
  it("continues to the next pool after an earlier one fails - both failures are reported, not just the first", async () => {
    const poolA = unresolvablePool("isolation-test-pool-a");
    const poolB = unresolvablePool("isolation-test-pool-b");

    const results = await indexAllPoolVolume([poolA, poolB], { rotationCursorKey: rotationCursorKey() });

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

    const results = await indexAllPoolVolume([poolA, poolB], { rotationCursorKey: rotationCursorKey() });

    for (const result of results) {
      expect(result.chunks).toEqual([]);
      expect(result.chunksCompleted).toBe(0);
    }
  });
});

describe("indexAllPoolVolume - Phase 5.10: rotation fairness", () => {
  afterEach(async () => {
    for (const component of createdRotationComponents.splice(0)) await db.delete(indexingState).where(eq(indexingState.component, component));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("REGRESSION: results are always returned in the ORIGINAL pools order, never the rotated processing order", async () => {
    const pools = Array.from({ length: 5 }, (_, i) => unresolvablePool(`order-test-${i}`));
    const key = rotationCursorKey();

    // Advance the rotation offset first so the SECOND call below starts
    // mid-list, not at offset 0 - the exact condition that would expose an
    // output-order bug if the fix accidentally returned results in
    // processing order instead of input order.
    await indexAllPoolVolume(pools, { rotationCursorKey: key });
    const results = await indexAllPoolVolume(pools, { rotationCursorKey: key });

    expect(results.map((r) => r.poolKey)).toEqual(pools.map((p) => p.key));
  });

  it("persists and advances a rotation cursor across successive calls, isolated from a different injected key", async () => {
    const pools = Array.from({ length: 3 }, (_, i) => unresolvablePool(`rotation-test-${i}`));
    const keyA = rotationCursorKey();
    const keyB = rotationCursorKey();

    await indexAllPoolVolume(pools, { rotationCursorKey: keyA });
    await indexAllPoolVolume(pools, { rotationCursorKey: keyA });

    const [rowA] = await db.select().from(indexingState).where(eq(indexingState.component, keyA.component));
    // 2 calls, each advancing by min(PRIORITY_BATCH_SIZE=10, 3 pools) = 3.
    expect(rowA.lastProcessedBlock).toBe("6");

    // A completely different key never touched by the calls above.
    const rowsB = await db.select().from(indexingState).where(eq(indexingState.component, keyB.component));
    expect(rowsB).toHaveLength(0);
  });

  it("an empty pool list makes no rotation cursor read/write at all", async () => {
    const key = rotationCursorKey();
    const results = await indexAllPoolVolume([], { rotationCursorKey: key });
    expect(results).toEqual([]);
    const rows = await db.select().from(indexingState).where(eq(indexingState.component, key.component));
    expect(rows).toHaveLength(0);
  });
});
