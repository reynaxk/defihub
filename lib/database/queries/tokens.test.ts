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
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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

  it("getTokenPriceChange7d itself is unaffected by an insert landing immediately after its first database read", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const tokenId = await makeToken(chain.id, `RACE${randomUUID().slice(0, 6)}`);
    createdTokenIds.push(tokenId);

    const t0 = new Date();
    await addPrice(tokenId, t0, 1, { priceChange7d: "42" });
    // All setup above must finish (and stop using the client) before the
    // spy below goes in - it targets the *next* query the client issues,
    // and seeding data through the same client would otherwise trip it.

    // Every query drizzle-orm's postgres-js driver issues - regardless of
    // how many separate `db.select(...)` calls the calling function
    // makes - funnels through this one method (confirmed against
    // node_modules/drizzle-orm/postgres-js/session.js: `client.unsafe(...)`
    // is the actual dispatch point). Intercepting it here, rather than
    // adding a hook parameter to getTokenPriceChange7d itself, exercises
    // the real production function unmodified: whatever query shape it
    // actually uses, the very first physical query it sends triggers the
    // "intervening insert" the instant that query resolves, then every
    // call (including that first one) proceeds normally.
    //
    // This is precisely why it discriminates a fixed implementation from
    // a reverted one without needing to know which is running:
    //   - One statement (the fix): that statement has already computed
    //     its full, consistent result *before* this hook's insert runs -
    //     the insert lands strictly after the only read completes, so the
    //     function correctly reports the pre-insert state (42).
    //   - Two separate statements (the bug): the first (changeRow) has
    //     already returned when the insert lands, but the second
    //     (latestRow) hasn't run yet - it fires afterward and sees the
    //     new row, pairing a stale changeRow with a newer latestRow and
    //     computing an impossible >24h gap (returns null instead of 42).
    const rawClient = db.$client;
    const originalUnsafe = rawClient.unsafe.bind(rawClient);
    let intercepted = false;
    const spy = vi.spyOn(rawClient, "unsafe").mockImplementation((...args: Parameters<typeof originalUnsafe>) => {
      const pending = originalUnsafe(...args);
      if (intercepted) return pending;
      intercepted = true;

      // postgres.js's Query class extends Promise; .values()/.raw() just
      // mutate a flag and `return this` (confirmed against
      // node_modules/postgres/cjs/src/query.js), so whichever chain
      // drizzle uses (`client.unsafe(...).values()` or plain
      // `client.unsafe(...)`), it's still this exact same object by the
      // time anything awaits it. Overriding `.then` as an own property on
      // this one instance - not replacing the object itself - intercepts
      // that eventual await while every other method (.values, .raw,
      // .execute) stays untouched and fully working, and guarantees the
      // insert genuinely finishes before whatever called .then() gets
      // control back (a plain second `.then()` attached to the same
      // promise would not: callback order is preserved, but an async
      // callback doesn't block a sibling callback from starting).
      // pending.then can end up called more than once on the same query
      // object (e.g. drizzle-orm's tracing span wrapper awaits it
      // independently of the actual consuming code) - this guard makes
      // sure the insert itself only ever runs once no matter how many
      // times that happens, rather than assuming a single call.
      let insertStarted = false;
      const originalThen = pending.then.bind(pending);
      pending.then = ((onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        originalThen(async (value: unknown) => {
          if (!insertStarted) {
            insertStarted = true;
            // A fresh, valid 7d figure 30 hours later - exactly what a
            // real sync:tokens discovery-sync tick landing here would write.
            await addPrice(tokenId, new Date(t0.getTime() + 30 * 60 * 60 * 1000), 2, { priceChange7d: "99" });
          }
          return onFulfilled ? onFulfilled(value) : value;
        }, onRejected)) as typeof pending.then;

      return pending;
    });

    try {
      const result = await getTokenPriceChange7d(tokenId);
      // 42 is the only answer consistent with a read that completed
      // before the insert landed - a correct implementation can't know
      // about a row that didn't exist yet when its snapshot was taken.
      // null (what the pre-fix two-query version returns here) is not a
      // valid answer for either point in time; if this ever regresses
      // back to two separate reads, this assertion fails.
      expect(result).not.toBeNull();
      expect(result).toBe(42);
    } finally {
      spy.mockRestore();
    }
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
