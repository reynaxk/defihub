// Real-Postgres integration test for getExternalTokenPrice/
// isExternalTokenPriceFresh - the discovered-pool TVL path's external-price
// fallback (see this file's own module comment). Same isolated,
// randomly-named test chain/token pattern as
// pricing/queries.integration.test.ts's getNativeTokenPrice tests.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, tokenPrices, tokens } from "@/lib/database/schema";
import { getExternalTokenPrice, isExternalTokenPriceFresh, MAX_EXTERNAL_PRICE_AGE_MS } from "./external-token-price";

describe("getExternalTokenPrice", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndToken(coingeckoId: string | null = "some-real-token"): Promise<{ chainSlug: string; tokenId: string; address: string }> {
    const chainSlug = `external-price-test-${randomUUID().slice(0, 8)}`;
    const [chain] = await db
      .insert(chains)
      .values({ name: `External Price Test Chain ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    const [token] = await db
      .insert(tokens)
      .values({ chainId: chain.id, address, symbol: "TST", decimals: 18, coingeckoId })
      .returning({ id: tokens.id });

    return { chainSlug, tokenId: token.id, address };
  }

  it("returns null when this chain/address has never been synced as a token at all", async () => {
    const chainSlug = `external-price-test-${randomUUID().slice(0, 8)}`;
    const [chain] = await db.insert(chains).values({ name: `X ${randomUUID()}`, slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const result = await getExternalTokenPrice(chainSlug, "0xneverseen");
    expect(result).toBeNull();
  });

  it("returns null when the token is tracked but has no coingeckoId resolved - never guessed", async () => {
    const { chainSlug, address } = await makeChainAndToken(null);
    const result = await getExternalTokenPrice(chainSlug, address);
    expect(result).toBeNull();
  });

  it("returns null when the token has a coingeckoId but no price has ever been synced for it", async () => {
    const { chainSlug, address } = await makeChainAndToken();
    const result = await getExternalTokenPrice(chainSlug, address);
    expect(result).toBeNull();
  });

  it("returns the latest synced price with its real coingeckoId when one exists", async () => {
    const { chainSlug, tokenId, address } = await makeChainAndToken("some-real-token");
    await db.insert(tokenPrices).values([
      { tokenId, timestamp: new Date("2026-08-26T00:00:00.000Z"), priceUsd: "1.10000000" },
      { tokenId, timestamp: new Date("2026-08-26T01:00:00.000Z"), priceUsd: "1.25000000" }, // latest wins
    ]);

    const result = await getExternalTokenPrice(chainSlug, address);
    expect(result).toEqual({ priceUsd: "1.25000000", coingeckoId: "some-real-token", observedAt: new Date("2026-08-26T01:00:00.000Z") });
  });

  it("address lookup is case-insensitive (matches getTokenIdByAddress's own lowercased-storage convention)", async () => {
    const { chainSlug, tokenId, address } = await makeChainAndToken();
    await db.insert(tokenPrices).values({ tokenId, timestamp: new Date(), priceUsd: "1.00000000" });

    const result = await getExternalTokenPrice(chainSlug, address.toUpperCase());
    expect(result).not.toBeNull();
  });
});

describe("isExternalTokenPriceFresh", () => {
  const NOW = new Date("2026-08-26T12:00:00.000Z");

  it("accepts a price observed right now", () => {
    expect(isExternalTokenPriceFresh(NOW, NOW)).toBe(true);
  });

  it("accepts a price observed exactly at the freshness boundary (inclusive)", () => {
    const boundary = new Date(NOW.getTime() - MAX_EXTERNAL_PRICE_AGE_MS);
    expect(isExternalTokenPriceFresh(boundary, NOW)).toBe(true);
  });

  it("rejects a price observed one millisecond past the freshness boundary", () => {
    const justPast = new Date(NOW.getTime() - MAX_EXTERNAL_PRICE_AGE_MS - 1);
    expect(isExternalTokenPriceFresh(justPast, NOW)).toBe(false);
  });

  it("rejects a future-dated observation, never treated as extra-fresh", () => {
    const future = new Date(NOW.getTime() + 1);
    expect(isExternalTokenPriceFresh(future, NOW)).toBe(false);
  });
});
