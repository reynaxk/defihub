// Real-Postgres integration test for recordTokenPriceObservation - the
// exact same pattern as verify-vault.integration.test.ts, applied to
// Phase 5.3's own write path (entityType "token", metric "price_usd").
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, tokens } from "@/lib/database/schema";
import type { PriceSourceObservation } from "@/lib/database/schema";
import { recordTokenPriceObservation, type TokenPriceObservationRecord } from "./record-price-observation";

const SOURCES: PriceSourceObservation[] = [
  {
    sourceKind: "uniswap-v2",
    sourcePoolAddress: "0xpool",
    sourceChainSlug: "ethereum",
    pairedTokenSymbol: "USDC",
    pairedTokenAddress: "0xusdc",
    pairedTokenPriceUsd: "1.00",
    priceUsd: "2444.40",
    liquidityUsd: "20000000",
    reserveRaw: "4102476795628499120331",
    pairedReserveRaw: "10026031352833",
    included: true,
  },
];

describe("recordTokenPriceObservation", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndToken(): Promise<{ chainId: string; tokenId: string }> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Price Observation Test Chain ${randomUUID()}`, slug: `price-obs-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const [token] = await db
      .insert(tokens)
      .values({ chainId: chain.id, address: `0xtoken${randomUUID().slice(0, 8)}`, symbol: "TST", decimals: 18 })
      .returning({ id: tokens.id });

    return { chainId: chain.id, tokenId: token.id };
  }

  function baseRecord(overrides: Partial<TokenPriceObservationRecord> = {}, tokenId: string, chainId: string): TokenPriceObservationRecord {
    return {
      tokenId,
      chainId,
      priceUsd: "2444.40000000",
      blockNumber: "19000000",
      blockHash: "0x" + "aa".repeat(32),
      timestamp: new Date("2026-08-26T00:00:00.000Z"),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: new Date("2026-08-26T00:00:00.000Z"),
      calculationInputs: SOURCES,
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
      ...overrides,
    };
  }

  it("writes a real row with full provenance - block number, block hash, timestamp, and source identity", async () => {
    const { chainId, tokenId } = await makeChainAndToken();
    const outcome = await recordTokenPriceObservation(baseRecord({}, tokenId, chainId));
    expect(outcome).toBe("written");

    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, tokenId));
    expect(row.entityType).toBe("token");
    expect(row.metric).toBe("price_usd");
    expect(row.value).toBe("2444.40000000");
    expect(row.blockNumber).toBe("19000000");
    expect(row.blockHash).toBe("0x" + "aa".repeat(32));
    expect(row.timestamp.getTime()).toBe(new Date("2026-08-26T00:00:00.000Z").getTime());
    expect(row.priceSource).toBe("onchain-pricing-engine");
    expect(row.source).toBe("onchain-pricing-engine");
    expect(row.confidence).toBe("HIGH");
    expect(row.priceLabel).toBe("ONCHAIN_NATIVE");
    expect((row.calculationInputs as PriceSourceObservation[])[0].sourcePoolAddress).toBe("0xpool");
  });

  it("skips the write (without throwing) when tokenId is null - token not yet synced", async () => {
    const { chainId } = await makeChainAndToken();
    const outcome = await recordTokenPriceObservation(baseRecord({ tokenId: null }, "unused", chainId));
    expect(outcome).toBe("skipped-no-token");
  });

  it("skips the write when the block hash is missing or malformed, never fabricating one", async () => {
    const { chainId, tokenId } = await makeChainAndToken();

    for (const blockHash of [null, "0xnotarealhash"]) {
      const outcome = await recordTokenPriceObservation(baseRecord({ blockHash }, tokenId, chainId));
      expect(outcome).toBe("skipped-invalid-hash");
    }

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, tokenId));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent for a repeated write at the same block+hash - exactly one row, first write survives", async () => {
    const { chainId, tokenId } = await makeChainAndToken();
    await recordTokenPriceObservation(baseRecord({}, tokenId, chainId));
    await recordTokenPriceObservation(baseRecord({ priceUsd: "9999.00000000" }, tokenId, chainId));

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, tokenId));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("2444.40000000");
  });

  it("treats a different block hash at the same block number as a distinct observation - a reorg, not deduplicated", async () => {
    const { chainId, tokenId } = await makeChainAndToken();
    await recordTokenPriceObservation(baseRecord({}, tokenId, chainId));
    await recordTokenPriceObservation(baseRecord({ blockHash: "0x" + "bb".repeat(32), priceUsd: "2500.00000000" }, tokenId, chainId));

    const rows = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, tokenId));
    expect(rows).toHaveLength(2);
  });
});
