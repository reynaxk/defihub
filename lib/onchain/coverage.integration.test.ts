// Real-Postgres integration test for getVolumeCoverage - the live-query
// half of the coverage registry (getStaticCoverage, the pure config-driven
// half, is tested in coverage.test.ts).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, pools, type VolumeCalculationInput } from "@/lib/database/schema";
import type { VolumeSourcePool } from "./volume/config";
import { getVolumeCoverage } from "./coverage";

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

describe("getVolumeCoverage", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(): Promise<{ chainSlug: string; chainId: string; poolId: string; configKey: string }> {
    const chainSlug = `coverage-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: "Coverage Test Chain", slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const configKey = `coverage-test-pool-${randomUUID()}`;
    const [pool] = await db.insert(pools).values({ configKey, chainId: chain.id, label: "Test Pool", address: `0xpool${randomUUID().slice(0, 8)}` }).returning({ id: pools.id });

    return { chainSlug, chainId: chain.id, poolId: pool.id, configKey };
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

  async function insertObservation(poolId: string, chainId: string, metric: string, value: string) {
    await db.insert(historicalObservations).values({
      chainId,
      entityType: "pool",
      entityId: poolId,
      metric,
      value,
      timestamp: new Date(),
      blockNumber: "100",
      blockHash: "0x" + "aa".repeat(32),
      calculationInputs: CALC_INPUT,
      source: "onchain-volume-engine",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
    });
  }

  it("never reports revenue as NATIVE when no revenue_usd observation exists - even though volume/fees do", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await insertObservation(poolId, chainId, "volume_usd", "1000");
    await insertObservation(poolId, chainId, "fees_usd", "3");
    // Deliberately NO revenue_usd observation - mirrors this phase's real,
    // live-verified pool whose feeTo() is active (revenue unavailable).

    const coverage = await getVolumeCoverage([fakePool(chainSlug, configKey)]);
    const volume = coverage.find((c) => c.metric === "volume_usd");
    const fees = coverage.find((c) => c.metric === "fees_usd");
    const revenue = coverage.find((c) => c.metric === "revenue_usd");

    expect(volume?.source).toBe("NATIVE");
    expect(fees?.source).toBe("NATIVE");
    expect(revenue?.source).not.toBe("NATIVE");
    expect(revenue?.source).toBe("UNSUPPORTED");
    expect(revenue?.knownLimitations.length).toBeGreaterThan(0);
  });

  it("reports revenue as NATIVE once a genuine revenue_usd observation exists (e.g. a verified-zero-feeTo pool)", async () => {
    const { chainSlug, chainId, poolId, configKey } = await makeChainAndPool();
    await insertObservation(poolId, chainId, "volume_usd", "1000");
    await insertObservation(poolId, chainId, "fees_usd", "3");
    await insertObservation(poolId, chainId, "revenue_usd", "0");

    const coverage = await getVolumeCoverage([fakePool(chainSlug, configKey)]);
    const revenue = coverage.find((c) => c.metric === "revenue_usd");

    expect(revenue?.source).toBe("NATIVE");
    expect(revenue?.knownLimitations).toEqual([]);
    expect(revenue?.lastObservationValueUsd).toBe("0.00000000");
  });
});
