// Real-Postgres integration tests for the range-bounded history query
// functions added for server-side chart range pushdown (getChainHistory,
// getProtocolHistory, getTokenHistory) - the boundary behavior of the
// `timestamp >= since` push-down is the actual thing under test. Timestamps
// are built from one fixed pivot rather than "now minus N", so "exactly at
// the cutoff" is a real, unambiguous case rather than something that could
// drift with wall-clock timing.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols, tokenPrices, tokens } from "@/lib/database/schema";
import { getChainHistory } from "./chains";
import { getProtocolHistory } from "./protocols";
import { getTokenHistory } from "./tokens";

const PIVOT = new Date("2026-01-01T00:00:00.000Z");
const BEFORE = new Date(PIVOT.getTime() - 60 * 60 * 1000);
const AFTER = new Date(PIVOT.getTime() + 60 * 60 * 1000);

async function makeChain() {
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
    .returning({ id: chains.id });
  return chain.id;
}

describe("range-bounded history queries", () => {
  const createdChainIds: string[] = [];
  const createdProtocolIds: string[] = [];
  const createdTokenIds: string[] = [];

  afterEach(async () => {
    for (const id of createdTokenIds.splice(0)) await db.delete(tokens).where(eq(tokens.id, id));
    for (const id of createdProtocolIds.splice(0)) await db.delete(protocols).where(eq(protocols.id, id));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("getChainHistory", () => {
    it("returns every row when since is null", async () => {
      const chainId = await makeChain();
      createdChainIds.push(chainId);
      await db.insert(chainMetrics).values([
        { chainId, timestamp: BEFORE, tvl: "1.00" },
        { chainId, timestamp: AFTER, tvl: "2.00" },
      ]);

      const all = await getChainHistory(chainId, null);
      expect(all).toHaveLength(2);
    });

    it("includes a row exactly at the cutoff and excludes one before it", async () => {
      const chainId = await makeChain();
      createdChainIds.push(chainId);
      await db.insert(chainMetrics).values([
        { chainId, timestamp: BEFORE, tvl: "1.00" },
        { chainId, timestamp: PIVOT, tvl: "2.00" },
        { chainId, timestamp: AFTER, tvl: "3.00" },
      ]);

      const bounded = await getChainHistory(chainId, PIVOT);
      expect(bounded.map((r) => r.tvl)).toEqual([2, 3]);
    });

    it("returns an empty array for a chain with no metrics at all", async () => {
      const chainId = await makeChain();
      createdChainIds.push(chainId);

      const result = await getChainHistory(chainId, PIVOT);
      expect(result).toEqual([]);
    });
  });

  describe("getProtocolHistory", () => {
    it("bounds by timestamp and only returns aggregate (chain_id null) rows", async () => {
      const [protocol] = await db
        .insert(protocols)
        .values({ name: `Test Protocol ${randomUUID()}`, slug: `test-protocol-${randomUUID()}` })
        .returning({ id: protocols.id });
      createdProtocolIds.push(protocol.id);

      const chainId = await makeChain();
      createdChainIds.push(chainId);

      await db.insert(protocolMetrics).values([
        { protocolId: protocol.id, chainId: null, timestamp: BEFORE, tvl: "1.00" },
        { protocolId: protocol.id, chainId: null, timestamp: AFTER, tvl: "2.00" },
        // A per-chain row at the same later timestamp - must not leak into
        // the aggregate-only history.
        { protocolId: protocol.id, chainId, timestamp: AFTER, tvl: "99.00" },
      ]);

      const bounded = await getProtocolHistory(protocol.id, PIVOT);
      expect(bounded).toHaveLength(1);
      expect(bounded[0].tvl).toBe(2);
    });
  });

  describe("getTokenHistory", () => {
    it("bounds by timestamp", async () => {
      const chainId = await makeChain();
      createdChainIds.push(chainId);

      const [token] = await db
        .insert(tokens)
        .values({ chainId, address: `0xtest${randomUUID().slice(0, 8)}`, symbol: "TST" })
        .returning({ id: tokens.id });
      createdTokenIds.push(token.id);

      await db.insert(tokenPrices).values([
        { tokenId: token.id, timestamp: BEFORE, priceUsd: "1.00" },
        { tokenId: token.id, timestamp: AFTER, priceUsd: "2.00" },
      ]);

      const bounded = await getTokenHistory(token.id, PIVOT);
      expect(bounded).toHaveLength(1);
      expect(bounded[0].priceUsd).toBe(2);

      const all = await getTokenHistory(token.id, null);
      expect(all).toHaveLength(2);
    });
  });
});
