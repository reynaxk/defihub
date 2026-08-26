// Real-Postgres integration test for recordVolumeObservation - same
// pattern as record-price-observation.integration.test.ts, applied to
// Phase 5.4's entityType "pool", metric "volume_usd"/"fees_usd"/
// "revenue_usd" rows.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools, type VolumeCalculationInput } from "@/lib/database/schema";
import { recordVolumeObservation, type VolumeObservationRecord } from "./record-volume-observation";

const CALC_INPUT: VolumeCalculationInput = {
  eventType: "Swap",
  sourceContract: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
  sourceChainSlug: "ethereum",
  fromBlock: "25839000",
  toBlock: "25839100",
  swapCount: 24,
  pricedSwapCount: 24,
  unpricedSwapCount: 0,
  token0: { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, priceUsd: "1.00", priceSource: "onchain-pricing-engine" },
  token1: { symbol: "WETH", coingeckoId: "weth", decimals: 18, priceUsd: "2447.00", priceSource: "onchain-pricing-engine" },
};

describe("recordVolumeObservation", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(): Promise<{ chainId: string; poolId: string }> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Volume Obs Test Chain ${randomUUID()}`, slug: `volume-obs-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const [pool] = await db
      .insert(pools)
      .values({ configKey: `volume-obs-test-pool-${randomUUID()}`, chainId: chain.id, label: "Test Pool", address: `0xpool${randomUUID().slice(0, 8)}` })
      .returning({ id: pools.id });

    return { chainId: chain.id, poolId: pool.id };
  }

  function baseRecord(overrides: Partial<VolumeObservationRecord> = {}, poolId: string, chainId: string): VolumeObservationRecord {
    return {
      poolId,
      chainId,
      metric: "volume_usd",
      value: "58432.10000000",
      blockNumber: "25839660",
      blockHash: "0x" + "aa".repeat(32),
      timestamp: new Date("2026-08-26T13:05:59.000Z"),
      calculationInputs: CALC_INPUT,
      calculationVersion: "uniswap-v2-input-side-only-v1",
      confidence: "HIGH",
      ...overrides,
    };
  }

  it("writes a real volume_usd row with full provenance", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const outcome = await recordVolumeObservation(baseRecord({}, poolId, chainId));
    expect(outcome).toBe("written");

    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(row.entityType).toBe("pool");
    expect(row.metric).toBe("volume_usd");
    expect(row.value).toBe("58432.10000000");
    expect(row.blockNumber).toBe("25839660");
    expect(row.source).toBe("onchain-volume-engine");
    expect(row.confidence).toBe("HIGH");
    expect(row.priceLabel).toBe("ONCHAIN_NATIVE");
    expect((row.calculationInputs as VolumeCalculationInput).swapCount).toBe(24);
  });

  it("writes fees_usd as a genuinely separate row from volume_usd for the same pool/block", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await recordVolumeObservation(baseRecord({ metric: "volume_usd", value: "1000" }, poolId, chainId));
    await recordVolumeObservation(baseRecord({ metric: "fees_usd", value: "3" }, poolId, chainId));

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.metric).sort()).toEqual(["fees_usd", "volume_usd"]);
  });

  it("skips the write when the block hash is missing or malformed, never fabricating one", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    for (const blockHash of [null, "0xnotarealhash"]) {
      const outcome = await recordVolumeObservation(baseRecord({ blockHash }, poolId, chainId));
      expect(outcome).toBe("skipped-invalid-hash");
    }
    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent for a repeated write at the same block+hash+metric - exactly one row, first write survives", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await recordVolumeObservation(baseRecord({}, poolId, chainId));
    await recordVolumeObservation(baseRecord({ value: "999999.00000000" }, poolId, chainId));

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("58432.10000000");
  });

  it("treats a different block hash at the same block number as a distinct observation - a reorg, not a duplicate", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await recordVolumeObservation(baseRecord({}, poolId, chainId));
    await recordVolumeObservation(baseRecord({ blockHash: "0x" + "bb".repeat(32), value: "60000.00000000" }, poolId, chainId));

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(rows).toHaveLength(2);
  });
});
