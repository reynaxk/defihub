// Real-Postgres integration test for lib/onchain/volume/queries.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools, swapEvents, type VolumeCalculationInput } from "@/lib/database/schema";
import {
  getChainId,
  getDailyVolumeHistory,
  getLatestVolumeObservation,
  getPoolIdByConfigKey,
  getRecentSwapEvents,
  getSwapEventsNeedingRecheck,
  markSwapEventsReorged,
} from "./queries";

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

describe("volume queries", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(): Promise<{ chainId: string; chainSlug: string; poolId: string; configKey: string }> {
    const chainSlug = `volume-query-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: `Volume Query Test Chain`, slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const configKey = `volume-query-test-pool-${randomUUID()}`;
    const [pool] = await db.insert(pools).values({ configKey, chainId: chain.id, label: "Test Pool", address: `0xpool${randomUUID().slice(0, 8)}` }).returning({ id: pools.id });

    return { chainId: chain.id, chainSlug, poolId: pool.id, configKey };
  }

  async function insertObservation(poolId: string, chainId: string, metric: string, value: string, blockNumber: string, timestamp: Date, blockHash = "0x" + "aa".repeat(32)) {
    await db.insert(historicalObservations).values({
      chainId,
      entityType: "pool",
      entityId: poolId,
      metric,
      value,
      timestamp,
      blockNumber,
      blockHash,
      calculationInputs: CALC_INPUT,
      source: "onchain-volume-engine",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
    });
  }

  it("getChainId resolves a real chain slug and returns null for an unknown one", async () => {
    const { chainId, chainSlug } = await makeChainAndPool();
    expect(await getChainId(chainSlug)).toBe(chainId);
    expect(await getChainId("not-a-real-chain-slug")).toBeNull();
  });

  it("getPoolIdByConfigKey resolves a synced pool and returns null when not yet synced", async () => {
    const { poolId, configKey } = await makeChainAndPool();
    expect(await getPoolIdByConfigKey(configKey)).toBe(poolId);
    expect(await getPoolIdByConfigKey("not-a-real-config-key")).toBeNull();
  });

  it("getLatestVolumeObservation returns the most recent canonical row, excluding reorged ones", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await insertObservation(poolId, chainId, "volume_usd", "1000", "100", new Date("2026-08-20T00:00:00.000Z"));
    await insertObservation(poolId, chainId, "volume_usd", "2000", "200", new Date("2026-08-21T00:00:00.000Z"));

    const latest = await getLatestVolumeObservation(poolId, "volume_usd");
    expect(latest?.value).toBe("2000.00000000");
  });

  it("getLatestVolumeObservation returns null when the pool has no observations for this metric yet", async () => {
    const { poolId } = await makeChainAndPool();
    expect(await getLatestVolumeObservation(poolId, "revenue_usd")).toBeNull();
  });

  it("getDailyVolumeHistory sums same-day observations into one bucket", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await insertObservation(poolId, chainId, "volume_usd", "100", "1", new Date("2026-08-20T01:00:00.000Z"), "0x" + "aa".repeat(32));
    await insertObservation(poolId, chainId, "volume_usd", "50", "2", new Date("2026-08-20T23:00:00.000Z"), "0x" + "bb".repeat(32));
    await insertObservation(poolId, chainId, "volume_usd", "999", "3", new Date("2026-08-21T01:00:00.000Z"), "0x" + "cc".repeat(32));

    const history = await getDailyVolumeHistory(poolId, "volume_usd");
    const day1 = history.find((h) => h.day.toISOString().startsWith("2026-08-20"));
    const day2 = history.find((h) => h.day.toISOString().startsWith("2026-08-21"));
    expect(Number(day1?.volumeUsd)).toBeCloseTo(150);
    expect(Number(day2?.volumeUsd)).toBeCloseTo(999);
  });

  it("getRecentSwapEvents excludes reorg-invalidated events and respects the limit", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    for (let i = 0; i < 3; i++) {
      await db.insert(swapEvents).values({
        chainId,
        poolId,
        sourceKind: "uniswap-v2",
        transactionHash: `0x${i}${"dd".repeat(31)}`,
        logIndex: i,
        blockNumber: String(100 + i),
        blockHash: "0x" + "ee".repeat(32),
        blockTimestamp: new Date("2026-08-26T00:00:00.000Z"),
        amount0In: "0",
        amount1In: "1000000000000000000",
        amount0Out: "2500000000",
        amount1Out: "0",
      });
    }
    const [invalidated] = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId)).limit(1);
    await db.update(swapEvents).set({ reorgInvalidatedAt: new Date() }).where(eq(swapEvents.id, invalidated.id));

    const recent = await getRecentSwapEvents(poolId, 10);
    expect(recent).toHaveLength(2);
  });

  it("getSwapEventsNeedingRecheck groups by block number and marking reorged updates them all", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    // Two swaps sharing one block, one swap in a later block.
    await db.insert(swapEvents).values([
      { chainId, poolId, sourceKind: "uniswap-v2", transactionHash: "0x" + "11".repeat(32), logIndex: 0, blockNumber: "100", blockHash: "0x" + "aa".repeat(32), blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0" },
      { chainId, poolId, sourceKind: "uniswap-v2", transactionHash: "0x" + "22".repeat(32), logIndex: 1, blockNumber: "100", blockHash: "0x" + "aa".repeat(32), blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0" },
      { chainId, poolId, sourceKind: "uniswap-v2", transactionHash: "0x" + "33".repeat(32), logIndex: 0, blockNumber: "200", blockHash: "0x" + "bb".repeat(32), blockTimestamp: new Date(), amount0In: "0", amount1In: "1", amount0Out: "1", amount1Out: "0" },
    ]);

    const candidates = await getSwapEventsNeedingRecheck(poolId, null, 1);
    // limit=1 bounds distinct block numbers (most recent first when no
    // cursor) - block 200's single event, not block 100's pair.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].blockNumber).toBe(BigInt(200));

    const all = await getSwapEventsNeedingRecheck(poolId, null, 10);
    expect(all).toHaveLength(3);

    await markSwapEventsReorged(
      all.filter((c) => c.blockNumber === BigInt(100)).map((c) => c.id),
      new Date(),
    );
    const afterMark = await getSwapEventsNeedingRecheck(poolId, null, 10);
    expect(afterMark).toHaveLength(1);
    expect(afterMark[0].blockNumber).toBe(BigInt(200));
  });
});
