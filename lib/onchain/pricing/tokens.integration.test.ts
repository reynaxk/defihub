// Real-Postgres integration tests for ensureOnChainTokenRow (Phase 5.13) -
// same isolated-test-chain pattern this whole codebase's other DB
// integration tests already establish.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, tokens } from "@/lib/database/schema";
import { ensureOnChainTokenRow } from "./tokens";

describe("ensureOnChainTokenRow", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<string> {
    const [chain] = await db.insert(chains).values({ name: `Tokens Test ${randomUUID()}`, slug: `tokens-test-${randomUUID()}`, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  it("creates a new row with a null coingeckoId - honest, never guessed", async () => {
    const chainId = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;

    const tokenId = await ensureOnChainTokenRow(chainId, address, "TOK", 18);

    const [row] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(row.symbol).toBe("TOK");
    expect(row.decimals).toBe(18);
    expect(row.coingeckoId).toBeNull();
    expect(row.address).toBe(address.toLowerCase());
  });

  it("falls back to a short address prefix when symbol is null - never fabricates a plausible-looking symbol", async () => {
    const chainId = await makeChain();
    const address = "0xABCDEF1234567890abcdef1234567890abcdef12";

    const tokenId = await ensureOnChainTokenRow(chainId, address, null, 18);

    const [row] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(row.symbol).toBe(address.toLowerCase().slice(0, 10));
  });

  it("is idempotent - calling it twice for the same (chainId, address) returns the same row, not a duplicate", async () => {
    const chainId = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;

    const first = await ensureOnChainTokenRow(chainId, address, "TOK", 18);
    const second = await ensureOnChainTokenRow(chainId, address, "TOK", 18);
    expect(second).toBe(first);

    const rows = await db.select().from(tokens).where(eq(tokens.chainId, chainId));
    expect(rows).toHaveLength(1);
  });

  it("updates decimals/symbol on conflict with fresh on-chain data - an on-chain decimals()/symbol() read is authoritative", async () => {
    const chainId = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    await ensureOnChainTokenRow(chainId, address, "OLD", 6);

    const tokenId = await ensureOnChainTokenRow(chainId, address, "NEW", 18);

    const [row] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(row.symbol).toBe("NEW");
    expect(row.decimals).toBe(18);
  });

  it("REGRESSION: never overwrites an EXISTING real coingeckoId with null - a row already identified by the CoinGecko sync (workers/tokens/sync.ts) or a prior call to this function must keep that identity", async () => {
    const chainId = await makeChain();
    const address = `0xtoken${randomUUID().slice(0, 8)}`;
    // Simulates a row workers/tokens/sync.ts already populated with a real
    // CoinGecko identity, before this function ever touches it.
    await db.insert(tokens).values({ chainId, address: address.toLowerCase(), symbol: "REAL", decimals: 18, coingeckoId: "some-real-coingecko-id" });

    const tokenId = await ensureOnChainTokenRow(chainId, address, "REAL", 18);

    const [row] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(row.coingeckoId).toBe("some-real-coingecko-id");
  });

  it("address matching is case-insensitive - a mixed-case address resolves to the same lowercased row", async () => {
    const chainId = await makeChain();
    const lower = `0xtoken${randomUUID().slice(0, 8)}`;
    const first = await ensureOnChainTokenRow(chainId, lower, "TOK", 18);
    const second = await ensureOnChainTokenRow(chainId, "0x" + lower.slice(2).toUpperCase(), "TOK", 18);
    expect(second).toBe(first);
  });
});
