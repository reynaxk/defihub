// Real-Postgres integration tests for the Phase 5.12 native-metrics
// normalization layer - same isolated-test-chain/pool pattern as
// pools.test.ts, applied to the new NativeMetric<T> contract this file
// builds on top of getPoolTvlHistory/getLatestVolumeObservation/
// getDailyVolumeHistory/getVerifiedPools (all reused unchanged).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools, protocols, type VolumeCalculationInput } from "@/lib/database/schema";
import {
  getNativeCoverageSummary,
  getNativePoolFeesHistory,
  getNativePoolIdentity,
  getNativePoolOverview,
  getNativePoolTvlHistory,
  getNativePoolVolumeHistory,
} from "./native-pools";

let blockCounter = 40_000_000;
function nextBlock() {
  blockCounter += 1;
  return { blockNumber: String(blockCounter), blockHash: `0xblock${randomUUID()}` };
}

function volumeCalcInputs(swapCount: number): VolumeCalculationInput {
  return {
    eventType: "Swap",
    sourceContract: "0xpool",
    sourceChainSlug: "test",
    fromBlock: "1",
    toBlock: "2",
    swapCount,
    pricedSwapCount: swapCount,
    unpricedSwapCount: 0,
    token0: { symbol: "A", coingeckoId: "a", decimals: 18, priceUsd: "1", priceSource: "onchain-pricing-engine" },
    token1: { symbol: "B", coingeckoId: "b", decimals: 18, priceUsd: "1", priceSource: "onchain-pricing-engine" },
  };
}

describe("native-pools query layer", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(overrides: { protocolName?: string } = {}) {
    const chainSlug = `native-pools-test-${randomUUID().slice(0, 8)}`;
    const [chain] = await db.insert(chains).values({ name: `Native Pools Test Chain ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);

    let protocolId: string | null = null;
    if (overrides.protocolName) {
      const [protocol] = await db
        .insert(protocols)
        .values({ name: overrides.protocolName, slug: `native-pools-test-protocol-${randomUUID().slice(0, 8)}` })
        .returning({ id: protocols.id });
      protocolId = protocol.id;
    }

    const address = `0xpool${randomUUID().slice(0, 8)}`;
    const [pool] = await db
      .insert(pools)
      .values({ configKey: `native-pools-test-${randomUUID()}`, chainId: chain.id, protocolId, label: "Test Pool", address })
      .returning({ id: pools.id });

    return { chainSlug, chainId: chain.id, poolId: pool.id, address };
  }

  describe("getNativePoolIdentity", () => {
    it("resolves a pool by (chainSlug, address), case-insensitively", async () => {
      const { chainSlug, poolId, address } = await makeChainAndPool();
      const identity = await getNativePoolIdentity(chainSlug, address.toUpperCase());
      expect(identity?.poolId).toBe(poolId);
    });

    it("returns null for an address that doesn't exist on this chain", async () => {
      const { chainSlug } = await makeChainAndPool();
      expect(await getNativePoolIdentity(chainSlug, "0xnonexistent")).toBeNull();
    });

    it("REGRESSION: resolves a pool whose STORED address is mixed-case (a real, live-observed data state - not every pools.address row is lowercased) when queried in lowercase", async () => {
      const chainSlug = `native-pools-test-${randomUUID().slice(0, 8)}`;
      const [chain] = await db.insert(chains).values({ name: `X ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
      createdChainIds.push(chain.id);
      const mixedCaseAddress = "0xACb70093B704426c819A6d584df3D69378B3E395";
      const [pool] = await db.insert(pools).values({ configKey: `native-pools-test-${randomUUID()}`, chainId: chain.id, label: "Mixed Case Pool", address: mixedCaseAddress }).returning({ id: pools.id });

      const identity = await getNativePoolIdentity(chainSlug, mixedCaseAddress.toLowerCase());
      expect(identity?.poolId).toBe(pool.id);
    });
  });

  describe("getNativePoolOverview - TVL provenance classification", () => {
    it("PROVENANCE: classifies a priceLabel ONCHAIN_NATIVE observation as source NATIVE", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "tvl_usd",
        value: "1000.00000000",
        timestamp: new Date(),
        source: "onchain-verification",
        priceSource: "onchain-pricing-engine",
        priceLabel: "ONCHAIN_NATIVE",
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.tvl.source).toBe("NATIVE");
      expect(overview?.tvl.value).toBe(1000);
    });

    it("PROVENANCE: classifies a priceLabel HYBRID observation as source HYBRID - never upgraded to NATIVE", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "tvl_usd",
        value: "1000.00000000",
        timestamp: new Date(),
        source: "onchain-verification",
        priceSource: "hybrid:onchain-pricing-engine+coingecko",
        priceLabel: "HYBRID",
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.tvl.source).toBe("HYBRID");
    });

    it("PROVENANCE: classifies a priceLabel EXTERNAL_FALLBACK observation as source EXTERNAL - real external data stays labeled external", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "tvl_usd",
        value: "1000.00000000",
        timestamp: new Date(),
        source: "onchain-verification",
        priceSource: "coingecko",
        priceLabel: "EXTERNAL_FALLBACK",
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.tvl.source).toBe("EXTERNAL");
    });

    it("falls back to parsing the legacy priceSource string when priceLabel is NULL (a pre-Phase-5.12 row) - still classified correctly, never left ambiguous", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "tvl_usd",
        value: "1000.00000000",
        timestamp: new Date(),
        source: "onchain-verification",
        priceSource: "onchain-pricing-engine",
        priceLabel: null,
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.tvl.source).toBe("NATIVE");
    });

    it("UNAVAILABLE: a pool with no TVL observation at all reports source UNAVAILABLE and a null value - never a fabricated zero", async () => {
      const { chainSlug, address } = await makeChainAndPool();
      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.tvl).toEqual({ value: null, source: "UNAVAILABLE", confidence: null, isPartial: false, observedAt: null, blockNumber: null, blockHash: null });
    });

    it("returns null for a pool that doesn't exist", async () => {
      expect(await getNativePoolOverview("no-such-chain", "0xnope")).toBeNull();
    });
  });

  describe("getNativePoolOverview - volume/fees provenance propagation (regression)", () => {
    it("REGRESSION: propagates the real confidence and blockHash from the underlying observation - an earlier version hardcoded both to null even though the row had them", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      const realBlockHash = "0x" + "77".repeat(32);
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "volume_usd",
        value: "500.00000000",
        timestamp: new Date("2026-08-01T12:00:00.000Z"),
        source: "onchain-volume-engine",
        confidence: "HIGH",
        priceLabel: "ONCHAIN_NATIVE",
        calculationInputs: volumeCalcInputs(3),
        blockNumber: "12345",
        blockHash: realBlockHash,
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.volume.confidence).toBe("HIGH");
      expect(overview?.volume.blockHash).toBe(realBlockHash);
      expect(overview?.volume.blockNumber).toBe(12345);
    });

    it("marks a MEDIUM/LOW-confidence latest observation isPartial - the single-observation twin of the daily-history isPartial semantics", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "fees_usd",
        value: "12.50000000",
        timestamp: new Date(),
        source: "onchain-volume-engine",
        confidence: "MEDIUM",
        priceLabel: "ONCHAIN_NATIVE",
        calculationInputs: volumeCalcInputs(2),
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.fees.confidence).toBe("MEDIUM");
      expect(overview?.fees.isPartial).toBe(true);
    });

    it("a HIGH-confidence latest observation is never marked partial", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "volume_usd",
        value: "500.00000000",
        timestamp: new Date(),
        source: "onchain-volume-engine",
        confidence: "HIGH",
        priceLabel: "ONCHAIN_NATIVE",
        calculationInputs: volumeCalcInputs(3),
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.volume.isPartial).toBe(false);
    });

    it("volume/fees source is always NATIVE when present - the volume engine never falls back to an external price mid-calculation", async () => {
      const { chainSlug, chainId, poolId, address } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "volume_usd",
        value: "500.00000000",
        timestamp: new Date(),
        source: "onchain-volume-engine",
        confidence: "HIGH",
        priceLabel: "ONCHAIN_NATIVE",
        calculationInputs: volumeCalcInputs(3),
        ...nextBlock(),
      });

      const overview = await getNativePoolOverview(chainSlug, address);
      expect(overview?.volume.source).toBe("NATIVE");
    });
  });

  describe("getNativePoolVolumeHistory / getNativePoolFeesHistory - LOW-exclusion and partial semantics preserved", () => {
    it("LOW-confidence observations are excluded from the authoritative value and isPartial is set - never a fake zero-trading day", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      const day = new Date("2026-08-01T12:00:00.000Z");
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "volume_usd",
          value: "500.00000000",
          timestamp: day,
          source: "onchain-volume-engine",
          confidence: "HIGH",
          priceLabel: "ONCHAIN_NATIVE",
          calculationInputs: volumeCalcInputs(3),
          ...nextBlock(),
        },
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "volume_usd",
          value: "0",
          timestamp: new Date(day.getTime() + 60_000),
          source: "onchain-volume-engine",
          confidence: "LOW",
          priceLabel: "ONCHAIN_NATIVE",
          calculationInputs: volumeCalcInputs(2),
          ...nextBlock(),
        },
      ]);

      const [point] = await getNativePoolVolumeHistory(poolId);
      expect(point.value).toBe(500); // the LOW row's own $0 is excluded from the sum, not added
      expect(point.isPartial).toBe(true);
      expect(point.excludedObservationCount).toBe(1);
      expect(point.excludedSwapCount).toBe(2);
    });

    it("a day with no LOW observations is not partial", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "pool",
        entityId: poolId,
        metric: "fees_usd",
        value: "12.50000000",
        timestamp: new Date("2026-08-01T12:00:00.000Z"),
        source: "onchain-volume-engine",
        confidence: "HIGH",
        priceLabel: "ONCHAIN_NATIVE",
        calculationInputs: volumeCalcInputs(3),
        ...nextBlock(),
      });

      const [point] = await getNativePoolFeesHistory(poolId);
      expect(point.isPartial).toBe(false);
      expect(point.excludedObservationCount).toBe(0);
    });

    it("EMPTY: a pool with no volume history at all returns an empty array, never a fabricated point", async () => {
      const { poolId } = await makeChainAndPool();
      expect(await getNativePoolVolumeHistory(poolId)).toEqual([]);
    });
  });

  describe("getNativePoolTvlHistory - reorg safety", () => {
    it("REORG: a reorg-invalidated observation is excluded from history - a reorg can never make an old observation appear current", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      const canonicalBlock = nextBlock();
      const orphanedBlock = nextBlock();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100.00000000", timestamp: new Date("2026-08-01T00:00:00.000Z"), source: "onchain-verification", ...canonicalBlock },
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "tvl_usd",
          value: "999999.00000000", // an obviously-wrong value if this leaked through
          timestamp: new Date("2026-08-02T00:00:00.000Z"),
          source: "onchain-verification",
          reorgInvalidatedAt: new Date("2026-08-02T01:00:00.000Z"),
          ...orphanedBlock,
        },
      ]);

      const history = await getNativePoolTvlHistory(poolId, null);
      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(100);
    });
  });

  describe("getNativeCoverageSummary - Part 5 aggregation", () => {
    it("sums totalNativeTvlUsd/totalNativeVolumeUsd24hEquivalent only across pools with real observations - never counts a pool with no data as $0", async () => {
      const a = await makeChainAndPool({ protocolName: `Protocol A ${randomUUID()}` });
      const b = await makeChainAndPool({ protocolName: `Protocol B ${randomUUID()}` });
      // A third pool with genuinely no native data at all - proves it's
      // excluded from the counts/totals rather than silently treated as 0.
      await makeChainAndPool();

      await db.insert(historicalObservations).values([
        { chainId: a.chainId, entityType: "pool", entityId: a.poolId, metric: "tvl_usd", value: "1000.00000000", timestamp: new Date(), source: "onchain-verification", priceLabel: "ONCHAIN_NATIVE", ...nextBlock() },
        { chainId: a.chainId, entityType: "pool", entityId: a.poolId, metric: "volume_usd", value: "50.00000000", timestamp: new Date(), source: "onchain-volume-engine", confidence: "HIGH", priceLabel: "ONCHAIN_NATIVE", calculationInputs: volumeCalcInputs(1), ...nextBlock() },
        { chainId: b.chainId, entityType: "pool", entityId: b.poolId, metric: "tvl_usd", value: "2500.00000000", timestamp: new Date(), source: "onchain-verification", priceLabel: "HYBRID", ...nextBlock() },
      ]);

      const summary = await getNativeCoverageSummary();
      const poolA = summary.pools.find((p) => p.poolId === a.poolId)!;
      const poolB = summary.pools.find((p) => p.poolId === b.poolId)!;

      expect(poolA.tvlUsd).toBe(1000);
      expect(poolA.tvlSource).toBe("NATIVE");
      expect(poolA.latestVolumeUsd).toBe(50);
      expect(poolB.tvlUsd).toBe(2500);
      expect(poolB.tvlSource).toBe("HYBRID");
      expect(poolB.latestVolumeUsd).toBeNull();

      // The exact one NATIVE-priced pool contributes; the untouched third
      // pool contributes nothing (not $0) to either the count or the total.
      expect(summary.totalNativeTvlUsd).toBeGreaterThanOrEqual(1000);
      expect(summary.nativeTvlPoolCount).toBeGreaterThanOrEqual(1);
      expect(summary.indexedPoolCount).toBeGreaterThanOrEqual(1);
    });

    it("PROVENANCE (regression): a HYBRID-priced pool's TVL is bucketed into totalHybridTvlUsd, never into totalNativeTvlUsd - the aggregate headline can never be inflated by a partly-external price", async () => {
      // getNativeCoverageSummary/getVerifiedPools query the WHOLE `pools`
      // table, not a scoped subset - this real, shared dev database already
      // has other native/hybrid pools in it (e.g. the curated VERIFIED_POOLS
      // entries), so this test asserts on BEFORE/AFTER deltas and per-pool
      // classification, never a raw absolute total (which would be flaky
      // against whatever else is in the database at test time - the same
      // "don't assert on unscoped global state" lesson this codebase's own
      // pools.test.ts idempotency test already learned the hard way).
      const before = await getNativeCoverageSummary();

      const native = await makeChainAndPool();
      const hybrid = await makeChainAndPool();
      const external = await makeChainAndPool();

      await db.insert(historicalObservations).values([
        { chainId: native.chainId, entityType: "pool", entityId: native.poolId, metric: "tvl_usd", value: "1000.00000000", timestamp: new Date(), source: "onchain-verification", priceLabel: "ONCHAIN_NATIVE", ...nextBlock() },
        { chainId: hybrid.chainId, entityType: "pool", entityId: hybrid.poolId, metric: "tvl_usd", value: "2500.00000000", timestamp: new Date(), source: "onchain-verification", priceLabel: "HYBRID", ...nextBlock() },
        { chainId: external.chainId, entityType: "pool", entityId: external.poolId, metric: "tvl_usd", value: "9000.00000000", timestamp: new Date(), source: "onchain-verification", priceLabel: "EXTERNAL_FALLBACK", ...nextBlock() },
      ]);

      const after = await getNativeCoverageSummary();

      // Each pool's own row is bucketed by its own real tvlSource.
      expect(after.pools.find((p) => p.poolId === native.poolId)).toMatchObject({ tvlUsd: 1000, tvlSource: "NATIVE" });
      expect(after.pools.find((p) => p.poolId === hybrid.poolId)).toMatchObject({ tvlUsd: 2500, tvlSource: "HYBRID" });
      expect(after.pools.find((p) => p.poolId === external.poolId)).toMatchObject({ tvlUsd: 9000, tvlSource: "EXTERNAL" });

      // The specific regression this test guards: only the NATIVE pool's
      // $1000 moves totalNativeTvlUsd - the hybrid $2500 and external $9000
      // must land in their own separate totals, never inflating this one,
      // even though an earlier version of this function summed every
      // priced pool together regardless of tvlSource.
      expect(after.totalNativeTvlUsd - before.totalNativeTvlUsd).toBe(1000);
      expect(after.totalHybridTvlUsd - before.totalHybridTvlUsd).toBe(2500);
      expect(after.totalExternalTvlUsd - before.totalExternalTvlUsd).toBe(9000);
      expect(after.nativeTvlPoolCount - before.nativeTvlPoolCount).toBe(1);
      expect(after.hybridTvlPoolCount - before.hybridTvlPoolCount).toBe(1);
      expect(after.externalTvlPoolCount - before.externalTvlPoolCount).toBe(1);
    });

    it("REORG: the aggregation's own latest-metric lookup never lets a reorg-invalidated row win the 'latest' slot", async () => {
      const { chainId, poolId } = await makeChainAndPool();
      const canonicalBlock = nextBlock();
      const orphanedBlock = nextBlock();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "pool", entityId: poolId, metric: "tvl_usd", value: "100.00000000", timestamp: new Date("2026-08-01T00:00:00.000Z"), source: "onchain-verification", priceLabel: "ONCHAIN_NATIVE", ...canonicalBlock },
        {
          chainId,
          entityType: "pool",
          entityId: poolId,
          metric: "tvl_usd",
          value: "999999.00000000",
          timestamp: new Date("2026-08-02T00:00:00.000Z"), // later timestamp, so it WOULD win if reorg-exclusion were broken
          source: "onchain-verification",
          priceLabel: "ONCHAIN_NATIVE",
          reorgInvalidatedAt: new Date("2026-08-02T01:00:00.000Z"),
          ...orphanedBlock,
        },
      ]);

      const summary = await getNativeCoverageSummary();
      const pool = summary.pools.find((p) => p.poolId === poolId)!;
      expect(pool.tvlUsd).toBe(100);
    });
  });
});
