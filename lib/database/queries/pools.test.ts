// Real-Postgres integration tests for the Phase 4 pool-TVL query functions.
// getPoolTvlHistory's date-range boundary behavior is the main thing under
// test - same convention as history.test.ts's getChainHistory/
// getProtocolHistory/getTokenHistory tests, applied to the new
// historical_observations table.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools, type HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { computePoolTvl, roundExactDecimal, type PoolTvlToken } from "@/lib/onchain/verify-pool";
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
      expect(bounded.map((r) => r.value)).toEqual(["200.00000000", "300.00000000"]);
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
      expect(result[0].value).toBe("100.00000000");
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

    it("preserves a sub-cent value through insertion and read-back, never rounding it to $0.00", async () => {
      // historical_observations.value is numeric(32,8) specifically so a
      // real sub-cent TVL contribution survives - regression test for the
      // bug where the same 2-decimal string written to onchain_verifications
      // was also reused here, silently flooring anything under a cent to
      // "0.00" before it ever reached this higher-precision column. The
      // returned value is compared as the exact string the query layer
      // hands back - never Number(...)'d, which is a separate, later bug
      // this same regression now also guards against (see the next test).
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "tvl_usd",
          value: "0.0000005",
          timestamp: PIVOT,
          source: "onchain-verification",
        },
      ]);

      const [row] = await getPoolTvlHistory(poolId, null);
      expect(row.value).toBe("0.00000050");
      expect(row.value).not.toBe("0.00000000");
    });

    it("preserves a TVL above Number.MAX_SAFE_INTEGER with a fractional component through query round-trip, never through Number(...)", async () => {
      // This is the exact scenario a `Number(r.value)` conversion in the
      // query layer cannot survive: at this magnitude the double ULP is 2,
      // so parsing this exact string through Number() rounds it to the
      // even neighbor, 10000000000000000, silently discarding the ".5" -
      // demonstrated below via the same conversion, not asserted blindly.
      const { chainId, poolId } = await makeChainAndPool();
      const exactValue = "10000000000000000.50000000";
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: exactValue, timestamp: PIVOT, source: "onchain-verification" },
      ]);

      const [row] = await getPoolTvlHistory(poolId, null);
      expect(row.value).toBe(exactValue);
      expect(Number(exactValue)).toBe(10000000000000000);
    });

    it("round-trips block hash and price provenance, and the stored calculation inputs replay to the same value", async () => {
      const { chainId, poolId } = await makeChainAndPool();

      const calculationInputs: HistoricalObservationCalculationInput[] = [
        { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, balanceRaw: "2500000000", priceUsd: "1.001" },
        { symbol: "WETH", coingeckoId: "weth", decimals: 18, balanceRaw: "750000000000000000", priceUsd: "3200.5" },
      ];
      const priceRetrievedAt = new Date("2026-01-15T12:00:00.000Z");
      const blockHash = "0x" + "ab".repeat(32);

      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "tvl_usd",
          value: "4902.87500000",
          timestamp: PIVOT,
          blockNumber: "18000000",
          blockHash,
          priceSource: "coingecko",
          priceRetrievedAt,
          calculationInputs,
          source: "onchain-verification",
          calculationVersion: "pool-balance-sum-v1",
        },
      ]);

      const [row] = await getPoolTvlHistory(poolId, null);
      expect(row.blockHash).toBe(blockHash);
      expect(row.priceSource).toBe("coingecko");
      expect(row.priceRetrievedAt?.getTime()).toBe(priceRetrievedAt.getTime());
      expect(row.calculationInputs).toEqual(calculationInputs);

      // The actual replay: feed the round-tripped snapshot straight back
      // into computePoolTvl and confirm it reproduces the stored value -
      // proving these columns capture enough to redo the calculation, not
      // just descriptive metadata.
      const tokens: PoolTvlToken[] = row.calculationInputs!.map((i) => ({
        symbol: i.symbol,
        decimals: i.decimals,
        coingeckoId: i.coingeckoId,
      }));
      const balances = row.calculationInputs!.map((i) => BigInt(i.balanceRaw));
      const priceById = new Map(row.calculationInputs!.map((i) => [i.coingeckoId, i.priceUsd]));
      const replayed = computePoolTvl(tokens, balances, priceById);

      expect(replayed.ok).toBe(true);
      // computePoolTvl's own return trims trailing zeros;
      // historical_observations.value comes back padded to its full
      // numeric(32,8) scale - normalizing both sides through the same
      // roundExactDecimal call (production code's own rescale helper)
      // before comparing makes the padding difference a non-issue, without
      // ever routing either value through Number().
      expect(replayed.ok && roundExactDecimal(replayed.tvlUsd, 8)).toBe(roundExactDecimal(row.value, 8));
    });

    it("leaves block hash, price provenance, and calculation inputs null for an observation that never had them, rather than fabricating values", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100", timestamp: PIVOT, source: "onchain-verification" },
      ]);

      const [row] = await getPoolTvlHistory(poolId, null);
      expect(row.blockHash).toBeNull();
      expect(row.priceSource).toBeNull();
      expect(row.priceRetrievedAt).toBeNull();
      expect(row.calculationInputs).toBeNull();
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
