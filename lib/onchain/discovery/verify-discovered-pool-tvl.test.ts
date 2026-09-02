// Pure/DB-only tests for the discovered-pool native TVL path (Phase 5.12,
// Part 3) - verifyDiscoveredPoolsTvl itself needs a real chain client (RPC
// multicall + block reads), so - matching verify-pool.ts's own established
// convention of testing its pure/DB pieces rather than mocking a chain
// client for the full orchestrator - this file covers honestifyCalculationInputs
// (pure) directly and resolveDiscoveredTokenPrice (real Postgres, no RPC)
// via its own integration-style tests below.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, tokenPrices, tokens, type HistoricalObservationCalculationInput } from "@/lib/database/schema";
import type { NativePriceOverride } from "../pricing/tvl-integration";
import { honestifyCalculationInputs, resolveDiscoveredTokenPrice } from "./verify-discovered-pool-tvl";

describe("honestifyCalculationInputs", () => {
  const NATIVE_OVERRIDE: NativePriceOverride = {
    priceUsd: "698.90",
    sources: [],
    observedAt: new Date("2026-08-26T00:00:00.000Z"),
    blockNumber: 19000000,
    blockHash: "0x" + "aa".repeat(32),
  };

  function rawInput(overrides: Partial<HistoricalObservationCalculationInput> = {}): HistoricalObservationCalculationInput {
    return { symbol: "TOK", coingeckoId: "0xtoken0address", decimals: 18, balanceRaw: "1000000000000000000", priceUsd: "1.5", ...overrides };
  }

  it("PROVENANCE: a natively-priced token gets tokenAddress set, coingeckoId cleared, and real nativePriceProvenance attached - never mislabeled", () => {
    const raw = [rawInput({ coingeckoId: "0xwbnb" })];
    const nativeOverrideByKey = new Map([["0xwbnb", NATIVE_OVERRIDE]]);

    const [result] = honestifyCalculationInputs(raw, nativeOverrideByKey, new Map());

    expect(result.tokenAddress).toBe("0xwbnb");
    expect(result.coingeckoId).toBeUndefined();
    expect(result.nativePriceProvenance).toEqual({
      sources: [],
      observedAt: "2026-08-26T00:00:00.000Z",
      blockNumber: 19000000,
      blockHash: "0x" + "aa".repeat(32),
    });
  });

  it("PROVENANCE: an externally-priced token gets tokenAddress set AND its real coingeckoId restored - never left holding the synthetic address key", () => {
    const raw = [rawInput({ coingeckoId: "0xarbitrarytoken" })];
    const externalCoingeckoIdByKey = new Map([["0xarbitrarytoken", "some-real-listed-token"]]);

    const [result] = honestifyCalculationInputs(raw, new Map(), externalCoingeckoIdByKey);

    expect(result.tokenAddress).toBe("0xarbitrarytoken");
    expect(result.coingeckoId).toBe("some-real-listed-token");
    expect(result.nativePriceProvenance).toBeUndefined();
  });

  it("HYBRID: a pool with one native and one external token produces one entry of each shape in the same array - never uniformly labeled either way", () => {
    const raw = [rawInput({ symbol: "WBNB", coingeckoId: "0xwbnb" }), rawInput({ symbol: "ARB", coingeckoId: "0xarb" })];
    const nativeOverrideByKey = new Map([["0xwbnb", NATIVE_OVERRIDE]]);
    const externalCoingeckoIdByKey = new Map([["0xarb", "some-arb-token"]]);

    const [wbnb, arb] = honestifyCalculationInputs(raw, nativeOverrideByKey, externalCoingeckoIdByKey);

    expect(wbnb.nativePriceProvenance).toBeDefined();
    expect(wbnb.coingeckoId).toBeUndefined();
    expect(arb.nativePriceProvenance).toBeUndefined();
    expect(arb.coingeckoId).toBe("some-arb-token");
  });

  it("never fabricates a coingeckoId for a token matching neither map (defensive - unreachable via the real orchestrator)", () => {
    const raw = [rawInput({ coingeckoId: "0xunknown" })];
    const result = honestifyCalculationInputs(raw, new Map(), new Map());
    expect(result[0].tokenAddress).toBe("0xunknown");
    expect(result[0].coingeckoId).toBeUndefined();
    expect(result[0].nativePriceProvenance).toBeUndefined();
  });

  it("preserves every other field (symbol, decimals, balanceRaw, priceUsd) untouched", () => {
    const raw = [rawInput({ symbol: "WBNB", coingeckoId: "0xwbnb", decimals: 18, balanceRaw: "12345", priceUsd: "698.90" })];
    const [result] = honestifyCalculationInputs(raw, new Map([["0xwbnb", NATIVE_OVERRIDE]]), new Map());
    expect(result.symbol).toBe("WBNB");
    expect(result.decimals).toBe(18);
    expect(result.balanceRaw).toBe("12345");
    expect(result.priceUsd).toBe("698.90");
  });
});

describe("resolveDiscoveredTokenPrice", () => {
  const createdChainIds: string[] = [];
  const NOW = new Date("2026-08-26T12:00:00.000Z");

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<{ chainSlug: string; chainId: string }> {
    const chainSlug = `discovered-tvl-test-${randomUUID().slice(0, 8)}`;
    const [chain] = await db.insert(chains).values({ name: `Discovered TVL Test Chain ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return { chainSlug, chainId: chain.id };
  }

  it("returns null when neither a native nor an external price exists - genuinely unavailable, never guessed", async () => {
    const { chainSlug } = await makeChain();
    const result = await resolveDiscoveredTokenPrice(chainSlug, "0xnevertracked", NOW);
    expect(result).toBeNull();
  });

  it("prefers a confident, fresh native price over an available external one - native wins the same way resolveNativePriceOverrides' own precedent for VERIFIED_POOLS does", async () => {
    const { chainSlug, chainId } = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;

    const [token] = await db.insert(tokens).values({ chainId, address, symbol: "TST", decimals: 18, coingeckoId: "some-external-id" }).returning({ id: tokens.id });
    await db.insert(tokenPrices).values({ tokenId: token.id, timestamp: NOW, priceUsd: "1.00000000" });
    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: token.id,
      metric: "price_usd",
      value: "2444.40000000",
      timestamp: NOW,
      blockNumber: "19000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: NOW,
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "HIGH",
      priceLabel: "ONCHAIN_NATIVE",
    });

    const result = await resolveDiscoveredTokenPrice(chainSlug, address, NOW);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("native");
    expect(result?.priceUsd).toBe("2444.40000000");
  });

  it("falls back to the external price when no native price is available at all", async () => {
    const { chainSlug, chainId } = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    const [token] = await db.insert(tokens).values({ chainId, address, symbol: "TST", decimals: 18, coingeckoId: "some-external-id" }).returning({ id: tokens.id });
    await db.insert(tokenPrices).values({ tokenId: token.id, timestamp: NOW, priceUsd: "1.23000000" });

    const result = await resolveDiscoveredTokenPrice(chainSlug, address, NOW);
    expect(result).toEqual({ priceUsd: "1.23000000", kind: "external", coingeckoId: "some-external-id" });
  });

  it("falls back to external when a native price exists but is LOW confidence - never uses a native price that fails the same confidence bar VERIFIED_POOLS enforces", async () => {
    const { chainSlug, chainId } = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    const [token] = await db.insert(tokens).values({ chainId, address, symbol: "TST", decimals: 18, coingeckoId: "some-external-id" }).returning({ id: tokens.id });
    await db.insert(tokenPrices).values({ tokenId: token.id, timestamp: NOW, priceUsd: "1.23000000" });
    await db.insert(historicalObservations).values({
      chainId,
      entityType: "token",
      entityId: token.id,
      metric: "price_usd",
      value: "9999.00000000",
      timestamp: NOW,
      blockNumber: "19000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "onchain-pricing-engine",
      priceRetrievedAt: NOW,
      calculationInputs: [],
      source: "onchain-pricing-engine",
      calculationVersion: "reference-asset-v2-graph-v1",
      confidence: "LOW",
      priceLabel: "ONCHAIN_NATIVE",
    });

    const result = await resolveDiscoveredTokenPrice(chainSlug, address, NOW);
    expect(result?.kind).toBe("external");
    expect(result?.priceUsd).toBe("1.23000000");
  });

  it("returns null (never a guess) when a token has no coingeckoId resolved and no native price - the common case for an arbitrary discovered-pool token", async () => {
    const { chainSlug, chainId } = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    await db.insert(tokens).values({ chainId, address, symbol: "RAND", decimals: 18, coingeckoId: null });

    const result = await resolveDiscoveredTokenPrice(chainSlug, address, NOW);
    expect(result).toBeNull();
  });
});
