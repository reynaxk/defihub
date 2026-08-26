// Real-Postgres integration test for getNativeTokenPrice - the exact same
// "isolated, randomly-named test chain/token, real db import, no mocking"
// pattern verify-pool.integration.test.ts/verify-vault.integration.test.ts
// already establish, applied to Phase 5.3's own read path. Deliberately
// does NOT touch lib/onchain/pricing/config.ts's real REFERENCE_ASSETS
// entries (real "ethereum" chain, real token addresses) - a synthetic
// chain/token exercises the exact same query logic (the join, the latest-
// wins ordering, the reorg-exclusion filter) without any risk of colliding
// with real production data or a concurrently running worker.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, tokens } from "@/lib/database/schema";
import { getNativeTokenPrice } from "./queries";

describe("getNativeTokenPrice", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndToken(): Promise<{ chainSlug: string; chainId: string; tokenId: string; address: string }> {
    const chainSlug = `pricing-query-test-${randomUUID().slice(0, 8)}`;
    const [chain] = await db
      .insert(chains)
      .values({ name: `Pricing Query Test Chain ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    const [token] = await db
      .insert(tokens)
      .values({ chainId: chain.id, address, symbol: "TST", decimals: 18 })
      .returning({ id: tokens.id });

    return { chainSlug, chainId: chain.id, tokenId: token.id, address };
  }

  it("returns null when this engine has never priced the token - no price", async () => {
    const { chainSlug, address } = await makeChainAndToken();
    const result = await getNativeTokenPrice(chainSlug, address);
    expect(result).toBeNull();
  });

  it("returns the observation with its real confidence/label/provenance when one exists - native price", async () => {
    const { chainSlug, chainId, tokenId, address } = await makeChainAndToken();

    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: tokenId,
      metric: "price_usd",
      value: "2444.40000000",
      timestamp: new Date("2026-08-26T00:00:00.000Z"),
      blockNumber: "19000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: new Date("2026-08-26T00:00:00.000Z"),
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
    });

    const result = await getNativeTokenPrice(chainSlug, address);
    expect(result).not.toBeNull();
    expect(result!.priceUsd).toBe("2444.40000000");
    expect(result!.confidence).toBe("HIGH");
    expect(result!.label).toBe("ONCHAIN_NATIVE");
    expect(result!.blockNumber).toBe(19000000);
    expect(result!.blockHash).toBe("0x" + "aa".repeat(32));
  });

  it("still returns a LOW-confidence observation as-is - confidence gating is the caller's job, not this query's", async () => {
    const { chainSlug, chainId, tokenId, address } = await makeChainAndToken();

    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: tokenId,
      metric: "price_usd",
      value: "1.00000000",
      timestamp: new Date("2026-08-26T00:00:00.000Z"),
      blockNumber: "19000000",
      blockHash: "0x" + "bb".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: new Date("2026-08-26T00:00:00.000Z"),
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "LOW",
      priceLabel: "ONCHAIN_NATIVE",
    });

    const result = await getNativeTokenPrice(chainSlug, address);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("LOW");
  });

  it("returns the most recent observation when several exist - latest wins", async () => {
    const { chainSlug, chainId, tokenId, address } = await makeChainAndToken();

    for (const [value, blockHash, timestamp] of [
      ["2400.00000000", "0x" + "cc".repeat(32), new Date("2026-08-26T00:00:00.000Z")],
      ["2450.00000000", "0x" + "dd".repeat(32), new Date("2026-08-26T01:00:00.000Z")],
    ] as const) {
      await db.insert(historicalObservations).values({
        chainId,
        entityType: "token",
        entityId: tokenId,
        metric: "price_usd",
        value,
        timestamp,
        blockNumber: "19000000",
        blockHash,
        priceSource: "onchain-pricing-engine",
        priceRetrievedAt: timestamp,
        calculationInputs: [],
        source: "onchain-pricing-engine",
        calculationVersion: "reference-asset-v2-graph-v1",
        confidence: "HIGH",
        priceLabel: "ONCHAIN_NATIVE",
      });
    }

    const result = await getNativeTokenPrice(chainSlug, address);
    expect(result!.priceUsd).toBe("2450.00000000");
  });

  it("excludes a reorg-invalidated observation, even if it's the most recent one - never treats invalidated history as canonical", async () => {
    const { chainSlug, chainId, tokenId, address } = await makeChainAndToken();

    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: tokenId,
      metric: "price_usd",
      value: "2400.00000000",
      timestamp: new Date("2026-08-26T00:00:00.000Z"),
      blockNumber: "19000000",
      blockHash: "0x" + "ee".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: new Date("2026-08-26T00:00:00.000Z"),
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
    });
    // A LATER observation that got reorged away - still the most recent by
    // timestamp, but must never be returned as canonical.
    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: tokenId,
      metric: "price_usd",
      value: "9999.00000000",
      timestamp: new Date("2026-08-26T01:00:00.000Z"),
      blockNumber: "19000001",
      blockHash: "0x" + "ff".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: new Date("2026-08-26T01:00:00.000Z"),
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
      reorgInvalidatedAt: new Date("2026-08-26T02:00:00.000Z"),
    });

    const result = await getNativeTokenPrice(chainSlug, address);
    expect(result!.priceUsd).toBe("2400.00000000");
  });
});
