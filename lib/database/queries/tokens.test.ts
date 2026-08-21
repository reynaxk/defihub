// Real-Postgres integration test. The specific thing under test is
// correctness of the LATERAL-join rewrite in tokens.ts: getTokensList,
// getTopMovers, getTokensForBalanceCheck, and getNativeTokenPrice all read
// "the latest token_prices row per token" through a correlated LATERAL
// subquery rather than a plain DISTINCT ON joined afterward (see the comment
// on latestPriceLateral). A LATERAL correlation is easy to get subtly wrong
// in a way TypeScript can't catch - these tests seed multiple historical
// price rows per token (out of insertion order) and assert the *newest* one
// wins, not an arbitrary one.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, tokenPrices, tokens } from "@/lib/database/schema";
import {
  getNativeTokenPrice,
  getTokenPriceChange7d,
  getTokensForBalanceCheck,
  getTokensList,
  getTokensPageList,
  getTopMovers,
} from "./tokens";

async function makeChain(nativeToken = "TST") {
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test ${randomUUID()}`, slug: `test-${randomUUID()}`, nativeToken })
    .returning({ id: chains.id, slug: chains.slug });
  return chain;
}

async function makeToken(chainId: string, symbol: string) {
  const [token] = await db
    .insert(tokens)
    .values({ chainId, address: `0x${randomUUID().replace(/-/g, "")}`, symbol, decimals: 18 })
    .returning({ id: tokens.id });
  return token.id;
}

async function addPrice(tokenId: string, timestamp: Date, priceUsd: number, extra: Partial<typeof tokenPrices.$inferInsert> = {}) {
  await db.insert(tokenPrices).values({ tokenId, timestamp, priceUsd: priceUsd.toString(), ...extra });
}

describe("tokens queries - LATERAL join correctness", () => {
  const createdChainIds: string[] = [];
  const createdTokenIds: string[] = [];

  afterEach(async () => {
    for (const id of createdTokenIds.splice(0)) {
      await db.delete(tokenPrices).where(eq(tokenPrices.tokenId, id));
      await db.delete(tokens).where(eq(tokens.id, id));
    }
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("getTokensList reports the newest price row per token, not the first-inserted one", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const tokenId = await makeToken(chain.id, `TOK${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(tokenId);

    const now = new Date();
    // Inserted out of chronological order on purpose - a broken correlation
    // (e.g. accidentally picking MIN instead of MAX, or an unfiltered join)
    // could still pass if rows happened to be read back in insertion order.
    await addPrice(tokenId, new Date(now.getTime() - 60 * 60 * 1000), 10);
    await addPrice(tokenId, now, 42);
    await addPrice(tokenId, new Date(now.getTime() - 30 * 60 * 1000), 25);

    const list = await getTokensList({ chainSlug: chain.slug });
    const row = list.find((t) => t.id === tokenId);
    expect(row?.priceUsd).toBe(42);
  });

  it("getTopMovers ranks by the latest priceChange24h, and 7d falls back to the most recent non-null change", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const gainerTokenId = await makeToken(chain.id, `GAIN${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(gainerTokenId);

    const now = new Date();
    await addPrice(gainerTokenId, new Date(now.getTime() - 60 * 60 * 1000), 1, { priceChange24h: "-50" });
    await addPrice(gainerTokenId, now, 2, { priceChange24h: "500" });

    const { gainers } = await getTopMovers(50, "24h");
    const row = gainers.find((g) => g.id === gainerTokenId);
    expect(row).toBeDefined();
    expect(row?.priceChange).toBe(500);

    // 7d change: the latest row has no 7d figure (only the 6-hourly
    // discovery sync writes it) - must look back to the most recent row
    // that actually has one, not silently show null/the wrong value.
    const sevenDTokenId = await makeToken(chain.id, `SEV${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(sevenDTokenId);
    await addPrice(sevenDTokenId, new Date(now.getTime() - 2 * 60 * 60 * 1000), 1, { priceChange7d: "77" });
    await addPrice(sevenDTokenId, now, 2, {}); // latest row: priceChange7d null

    const { gainers: gainers7d } = await getTopMovers(50, "7d");
    const row7d = gainers7d.find((g) => g.id === sevenDTokenId);
    expect(row7d?.priceChange).toBe(77);
    // priceUsd must still come from the truly latest row (2), not the
    // older row that happened to carry the 7d figure (1).
    expect(row7d?.priceUsd).toBe(2);
  });

  it("getTokensForBalanceCheck and getNativeTokenPrice both report the latest price", async () => {
    const chain = await makeChain("NATV");
    createdChainIds.push(chain.id);
    const nativeTokenId = await makeToken(chain.id, "NATV");
    createdTokenIds.push(nativeTokenId);

    const now = new Date();
    await addPrice(nativeTokenId, new Date(now.getTime() - 60 * 60 * 1000), 1000);
    await addPrice(nativeTokenId, now, 3000);

    const balanceCheckTokens = await getTokensForBalanceCheck(chain.slug);
    const row = balanceCheckTokens.find((t) => t.symbol === "NATV");
    expect(row?.priceUsd).toBe(3000);

    const nativePrice = await getNativeTokenPrice(chain.slug);
    expect(nativePrice).toBe(3000);
  });

  it("getTokenPriceChange7d rejects a stale 7d figure once the current quote has moved past the freshness window", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const tokenId = await makeToken(chain.id, `STALE${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(tokenId);

    const now = new Date();
    // The only priceChange7d this token ever got, 2 days ago - stale by any
    // reasonable freshness window relative to the price row below.
    await addPrice(tokenId, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), 1, { priceChange7d: "42" });
    // Every price sync since (15-min cadence) has carried no 7d figure at
    // all, right up to the current quote.
    await addPrice(tokenId, now, 2, {});

    const change = await getTokenPriceChange7d(tokenId);
    expect(change).toBeNull();
  });

  it("getTokenPriceChange7d still returns a recent, within-window 7d figure", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const tokenId = await makeToken(chain.id, `FRESH${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(tokenId);

    const now = new Date();
    // A normal healthy gap: the 6-hourly discovery sync set this a couple
    // of hours before the most recent 15-min price-only tick.
    await addPrice(tokenId, new Date(now.getTime() - 2 * 60 * 60 * 1000), 1, { priceChange7d: "13.5" });
    await addPrice(tokenId, now, 2, {});

    const change = await getTokenPriceChange7d(tokenId);
    expect(change).toBe(13.5);
  });

  it("getTokensPageList respects sortDir - backs the sortable table header click", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const lowId = await makeToken(chain.id, `LOW${randomUUID().slice(0, 6)}`);
    const highId = await makeToken(chain.id, `HIGH${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(lowId, highId);

    const now = new Date();
    await addPrice(lowId, now, 1, { marketCap: "1000" });
    await addPrice(highId, now, 1, { marketCap: "9000" });

    const desc = await getTokensPageList({ chainSlug: chain.slug, sort: "marketCap", sortDir: "desc" });
    expect(desc.items[0]?.id).toBe(highId);

    const asc = await getTokensPageList({ chainSlug: chain.slug, sort: "marketCap", sortDir: "asc" });
    expect(asc.items[0]?.id).toBe(lowId);
  });
});
