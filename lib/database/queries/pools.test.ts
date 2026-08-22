// Real-Postgres integration tests for the Phase 4 pool-TVL query functions.
// getPoolTvlHistory's date-range boundary behavior is the main thing under
// test - same convention as history.test.ts's getChainHistory/
// getProtocolHistory/getTokenHistory tests, applied to the new
// historical_observations table.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools } from "@/lib/database/schema";
import { getPoolObservationCount, getPoolTvlHistory, getVerifiedPools } from "./pools";

const PIVOT = new Date("2026-02-01T00:00:00.000Z");
const BEFORE = new Date(PIVOT.getTime() - 60 * 60 * 1000);
const AFTER = new Date(PIVOT.getTime() + 60 * 60 * 1000);

describe("pool TVL query functions", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool() {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const [pool] = await db
      .insert(pools)
      .values({
        configKey: `test-pool-${randomUUID()}`,
        chainId: chain.id,
        label: "Test Pool",
        address: `0xpool${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: pools.id });

    return { chainId: chain.id, poolId: pool.id };
  }

  describe("getPoolTvlHistory", () => {
    it("includes an observation exactly at the cutoff and excludes one before it", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100", timestamp: BEFORE, source: "onchain-verification" },
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "200", timestamp: PIVOT, source: "onchain-verification" },
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "300", timestamp: AFTER, source: "onchain-verification" },
      ]);

      const bounded = await getPoolTvlHistory(poolId, PIVOT);
      expect(bounded.map((r) => r.value)).toEqual([200, 300]);
    });

    it("returns every row when since is null", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100", timestamp: BEFORE, source: "onchain-verification" },
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "200", timestamp: AFTER, source: "onchain-verification" },
      ]);

      const all = await getPoolTvlHistory(poolId, null);
      expect(all).toHaveLength(2);
    });

    it("never returns another pool's or another metric's observations", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      const other = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100", timestamp: PIVOT, source: "onchain-verification" },
        // A different pool, same timestamp - must not leak in.
        { chainId: other.chainId, entityType: "pool", entityId: other.poolId, metric: "tvl_usd", value: "999", timestamp: PIVOT, source: "onchain-verification" },
        // Same pool, a different (hypothetical future) metric - must not leak in.
        { chainId, entityType: "pool", entityId: poolId, metric: "volume_usd", value: "999", timestamp: PIVOT, source: "onchain-verification" },
      ]);

      const result = await getPoolTvlHistory(poolId, null);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(100);
    });

    it("preserves the real source and calculation version on each row, never fabricating either", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "tvl_usd",
          value: "42",
          timestamp: PIVOT,
          blockNumber: "18000000",
          source: "onchain-verification",
          calculationVersion: "pool-balance-sum-v1",
        },
      ]);

      const [row] = await getPoolTvlHistory(poolId, null);
      expect(row.blockNumber).toBe(18000000);
      expect(row.source).toBe("onchain-verification");
      expect(row.calculationVersion).toBe("pool-balance-sum-v1");
    });
  });

  describe("getPoolObservationCount", () => {
    it("counts observations and reports the earliest timestamp honestly", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "1", timestamp: BEFORE, source: "onchain-verification" },
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "2", timestamp: AFTER, source: "onchain-verification" },
      ]);

      const result = await getPoolObservationCount(poolId);
      expect(result.count).toBe(2);
      expect(result.earliestAt?.getTime()).toBe(BEFORE.getTime());
    });

    it("returns a real zero and a null earliestAt for a pool with no observations yet, not fabricated data", async () => {
      const { poolId } = await makeChainAndPool();
      const result = await getPoolObservationCount(poolId);
      expect(result.count).toBe(0);
      expect(result.earliestAt).toBeNull();
    });
  });

  describe("getVerifiedPools", () => {
    it("includes a pool synced from config but never yet verified, with a null latestTvlUsd rather than omitting it", async () => {
      const { chainId } = await makeChainAndPool();
      const [pool] = await db
        .insert(pools)
        .values({
          configKey: `unverified-${randomUUID()}`,
          chainId,
          label: "Not yet verified",
          address: `0xunverified${randomUUID().slice(0, 6)}`,
        })
        .returning({ id: pools.id, configKey: pools.configKey });

      const all = await getVerifiedPools();
      const found = all.find((p) => p.id === pool.id);
      expect(found).toBeDefined();
      expect(found?.latestTvlUsd).toBeNull();
    });
  });
});
