// Real-Postgres integration tests for lib/onchain/volume/reorg.ts - same
// "create real rows, inject readBlockHash, assert on real DB state"
// pattern as workers/onchain/recheck-reorgs.test.ts, scoped down: this
// module has exactly one entity shape (one pool's swap_events plus its
// three aggregate metrics) rather than that job's three entity types, so
// the scenario matrix is smaller. Advisory-lock contention itself
// (pg_try_advisory_lock returning false when another invocation already
// holds it) is NOT re-tested here - that raw Postgres mechanism is an
// unmodified copy of recheck-reorgs.ts's own already-tested pattern (see
// this module's own header comment for why it's a separate module at all),
// and re-proving generic advisory-lock semantics a second time would not
// catch anything specific to this module's own logic.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, indexingState, pools, swapEvents, type VolumeCalculationInput } from "@/lib/database/schema";
import type { VolumeSourcePool } from "./config";
import { recheckVolumeReorgs } from "./reorg";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

const CALC_INPUT: VolumeCalculationInput = {
  eventType: "Swap",
  sourceContract: "0xpool",
  sourceChainSlug: "ethereum",
  fromBlock: "1",
  toBlock: "2",
  swapCount: 1,
  pricedSwapCount: 1,
  unpricedSwapCount: 0,
  token0: { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, priceUsd: "1.00", priceSource: "onchain-pricing-engine" },
  token1: { symbol: "WETH", coingeckoId: "weth", decimals: 18, priceUsd: "2500.00", priceSource: "onchain-pricing-engine" },
};

describe("recheckVolumeReorgs", () => {
  const createdChainIds: string[] = [];
  // CodeRabbit fix round: indexing_state.chainSlug is a plain varchar, NOT
  // a foreign key to chains.id (see lib/database/schema.ts's own
  // indexingState definition) - deleting a chains row does NOT cascade-
  // delete the indexing_state rows recheckVolumeReorgs wrote for its slug,
  // so they were being silently left behind after every test that actually
  // exercised the recheck (every test but the "unsynced pool" one). Tracked
  // here so afterEach can clean them up explicitly.
  const createdChainSlugs: string[] = [];

  // CodeRabbit PR #17 fix: the pool-rotation cursor (selectReorgRecheckBatch's
  // persisted offset) lives on ONE fixed, un-namespaced indexing_state row
  // in production ("global" / "volume-reorg-recheck:pool-rotation") - unlike
  // every other cursor here, it is not scoped to a per-test chainSlug, so a
  // test that let recheckVolumeReorgs touch the real key would read/write
  // that shared row, risking cross-test interference and contaminating real
  // rotation state in the shared dev database. Every call below supplies its
  // own disposable rotationCursorKey instead (see VolumeReorgRecheckOptions
  // in reorg.ts), tracked here for cleanup exactly like createdChainSlugs.
  const createdRotationComponents: string[] = [];

  function rotationCursorKey(): { chainSlug: string; component: string } {
    const component = `test-rotation-${randomUUID()}`;
    createdRotationComponents.push(component);
    return { chainSlug: "test-rotation-global", component };
  }

  afterEach(async () => {
    for (const slug of createdChainSlugs.splice(0)) await db.delete(indexingState).where(eq(indexingState.chainSlug, slug));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
    for (const component of createdRotationComponents.splice(0)) await db.delete(indexingState).where(eq(indexingState.component, component));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(): Promise<{ chainSlug: string; poolId: string; configKey: string; chainId: string }> {
    const chainSlug = `volume-reorg-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: "Volume Reorg Test Chain", slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    createdChainSlugs.push(chainSlug);

    const configKey = `volume-reorg-test-pool-${randomUUID()}`;
    const [pool] = await db.insert(pools).values({ configKey, chainId: chain.id, label: "Test Pool", address: `0xpool${randomUUID().slice(0, 8)}` }).returning({ id: pools.id });

    return { chainSlug, poolId: pool.id, configKey, chainId: chain.id };
  }

  function fakePool(chainSlug: string, configKey: string): VolumeSourcePool {
    return {
      key: configKey,
      chainSlug,
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

  it("leaves canonical swap events and observations untouched, and advances both cursors", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values({
      chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"11".repeat(32)}`, logIndex: 0,
      blockNumber: "100", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
    });
    await db.insert(historicalObservations).values({
      chainId, entityType: "pool", entityId: poolId, metric: "volume_usd", value: "1000", timestamp: new Date(),
      blockNumber: "100", blockHash: HASH_A, calculationInputs: CALC_INPUT, source: "onchain-volume-engine", confidence: "HIGH", priceLabel: "ONCHAIN_NATIVE",
    });

    const stats = await recheckVolumeReorgs({ poolsOverride: [fakePool(chainSlug, configKey)], readBlockHash: async () => HASH_A, rotationCursorKey: rotationCursorKey() });

    expect(stats?.swapEventsReorged).toBe(0);
    expect(stats?.observationsReorged).toBe(0);
    expect(stats?.swapEventsChecked).toBe(1);
    expect(stats?.observationsChecked).toBe(1);

    const [swap] = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(swap.reorgInvalidatedAt).toBeNull();

    const swapState = await db.select().from(indexingState).where(eq(indexingState.component, `volume-reorg-recheck:pool:${configKey}:swap-events`));
    expect(swapState[0]?.status).toBe("idle");
    expect(swapState[0]?.lastProcessedBlock).toBe("100");
  });

  it("marks a swap event AND its pool's aggregate observation reorg-invalidated when the chain no longer matches - without deleting either row", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values({
      chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"22".repeat(32)}`, logIndex: 0,
      blockNumber: "200", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
    });
    await db.insert(historicalObservations).values({
      chainId, entityType: "pool", entityId: poolId, metric: "fees_usd", value: "3", timestamp: new Date(),
      blockNumber: "200", blockHash: HASH_A, calculationInputs: CALC_INPUT, source: "onchain-volume-engine", confidence: "HIGH", priceLabel: "ONCHAIN_NATIVE",
    });

    const stats = await recheckVolumeReorgs({ poolsOverride: [fakePool(chainSlug, configKey)], readBlockHash: async () => HASH_B, rotationCursorKey: rotationCursorKey() });

    expect(stats?.swapEventsReorged).toBe(1);
    expect(stats?.observationsReorged).toBe(1);

    const [swap] = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(swap.reorgInvalidatedAt).not.toBeNull();
    // Every other field is untouched - not deleted, not rewritten.
    expect(swap.amount1In).toBe("1");
    expect(swap.blockHash).toBe(HASH_A);

    const [obs] = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(obs.reorgInvalidatedAt).not.toBeNull();
    expect(obs.value).toBe("3.00000000");
  });

  it("does not advance the cursor past a block it could not resolve (readBlockHash failure), so it is retried next run", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values({
      chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"33".repeat(32)}`, logIndex: 0,
      blockNumber: "300", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
    });

    const stats = await recheckVolumeReorgs({
      poolsOverride: [fakePool(chainSlug, configKey)],
      readBlockHash: async () => {
        throw new Error("RPC down");
      },
      rotationCursorKey: rotationCursorKey(),
    });

    expect(stats?.swapEventsUnknown).toBe(1);
    const [swap] = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(swap.reorgInvalidatedAt).toBeNull(); // never guessed as reorged from a failed read

    const swapState = await db.select().from(indexingState).where(eq(indexingState.component, `volume-reorg-recheck:pool:${configKey}:swap-events`));
    expect(swapState[0]?.status).toBe("error");
    expect(swapState[0]?.lastProcessedBlock).toBeNull(); // cursor never advanced past the unresolved block
  });

  it("skips a pool that has not been synced into `pools` yet without failing the run", async () => {
    const stats = await recheckVolumeReorgs({
      poolsOverride: [fakePool("volume-reorg-unsynced-chain", "volume-reorg-unsynced-pool")],
      readBlockHash: async () => HASH_A,
      rotationCursorKey: rotationCursorKey(),
    });
    expect(stats?.poolsFailed).toBe(0);
    expect(stats?.swapEventsChecked).toBe(0);
  });

  it("caches a canonical block-hash read across two candidates sharing the exact same (blockNumber, blockHash) - exactly one injected readBlockHash call", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values([
      {
        chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"55".repeat(32)}`, logIndex: 0,
        blockNumber: "500", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
      },
      {
        chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"66".repeat(32)}`, logIndex: 0,
        blockNumber: "500", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
      },
    ]);

    let callCount = 0;
    const stats = await recheckVolumeReorgs({
      poolsOverride: [fakePool(chainSlug, configKey)],
      readBlockHash: async () => {
        callCount++;
        return HASH_A;
      },
      rotationCursorKey: rotationCursorKey(),
    });

    // Both candidates are still individually verified (the stat reflects
    // rows checked, not RPC calls made)...
    expect(stats?.swapEventsChecked).toBe(2);
    expect(stats?.swapEventsReorged).toBe(0);
    // ...but the underlying read only actually happened once, for the
    // shared (blockNumber, blockHash) pair.
    expect(callCount).toBe(1);
  });

  it("never shares a cached result between two candidates at the same block number but DIFFERENT block hashes - each gets its own, correct classification", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values([
      {
        chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"77".repeat(32)}`, logIndex: 0,
        blockNumber: "600", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
      },
      {
        chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"88".repeat(32)}`, logIndex: 0,
        blockNumber: "600", blockHash: HASH_B, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
      },
    ]);

    let callCount = 0;
    // The chain's real, current hash at block 600 is HASH_A - the row
    // stored with HASH_A is still canonical, the row stored with HASH_B
    // was orphaned by a reorg.
    const stats = await recheckVolumeReorgs({
      poolsOverride: [fakePool(chainSlug, configKey)],
      readBlockHash: async () => {
        callCount++;
        return HASH_A;
      },
      rotationCursorKey: rotationCursorKey(),
    });

    expect(stats?.swapEventsChecked).toBe(2);
    // Exactly one of the two is reorged - a shared cache entry (keyed on
    // blockNumber alone) would have wrongly classified both the same way.
    expect(stats?.swapEventsReorged).toBe(1);
    expect(callCount).toBe(2);

    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    const canonicalRow = rows.find((r) => r.blockHash === HASH_A);
    const reorgedRow = rows.find((r) => r.blockHash === HASH_B);
    expect(canonicalRow?.reorgInvalidatedAt).toBeNull();
    expect(reorgedRow?.reorgInvalidatedAt).not.toBeNull();
  });

  it("uses a component-key namespace distinct from recheck-reorgs.ts's own pool cursor, so the two never share a cursor", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await db.insert(swapEvents).values({
      chainId, poolId, sourceKind: "uniswap-v2", transactionHash: `0x${"44".repeat(32)}`, logIndex: 0,
      blockNumber: "400", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
    });

    await recheckVolumeReorgs({ poolsOverride: [fakePool(chainSlug, configKey)], readBlockHash: async () => HASH_A, rotationCursorKey: rotationCursorKey() });

    const rows = await db.select({ component: indexingState.component }).from(indexingState).where(eq(indexingState.chainSlug, chainSlug));
    for (const row of rows) {
      expect(row.component).toMatch(/^volume-reorg-recheck:pool:/);
      expect(row.component).not.toBe(`reorg-recheck:pool:${configKey}`);
    }
  });

  it("REGRESSION: advances the rotation cursor across successive runs so every pool is eventually rechecked, not just the first `batchSize` (CodeRabbit PR #17)", async () => {
    // 3 pools, batchSize 2 - the pre-fix behavior (a fixed
    // poolsToCheck.slice(0, batchSize)) would recheck pool A and B forever
    // and NEVER touch pool C on any run.
    const poolA = await makeChainAndPool();
    const poolB = await makeChainAndPool();
    const poolC = await makeChainAndPool();
    const pools_ = [poolA, poolB, poolC];

    for (const p of pools_) {
      await db.insert(swapEvents).values({
        chainId: p.chainId, poolId: p.poolId, sourceKind: "uniswap-v2", transactionHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0")}`, logIndex: 0,
        blockNumber: "700", blockHash: HASH_A, blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0",
      });
    }

    const key = rotationCursorKey();
    const sourcePools = pools_.map((p) => fakePool(p.chainSlug, p.configKey));
    const checkedAcrossRuns = new Set<string>();

    for (let run = 0; run < 2; run++) {
      const stats = await recheckVolumeReorgs({ poolsOverride: sourcePools, readBlockHash: async () => HASH_A, rotationCursorKey: key, batchSize: 2 });
      expect(stats?.poolsConsidered).toBe(2);
      // Identify which pools were actually touched this run via their
      // per-pool swap-events cursor advancing to block 700.
      for (const p of pools_) {
        const state = await db.select().from(indexingState).where(eq(indexingState.component, `volume-reorg-recheck:pool:${p.configKey}:swap-events`));
        if (state[0]?.lastProcessedBlock === "700") checkedAcrossRuns.add(p.configKey);
      }
    }

    // After 2 runs of a 3-pool list at batchSize 2 (2 + 1, wrapping), every
    // pool has been rechecked at least once.
    expect(checkedAcrossRuns.size).toBe(3);
  });
});
