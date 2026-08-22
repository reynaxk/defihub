// Real-Postgres integration test for getChainProtocolCounts. The thing
// under test: it must report a chain's true protocol-association count via
// a real COUNT(*), not the capped slice getChainBySlug's own `topProtocols`
// returns (limit(50) - see that function) - a chain with more real
// associations than that cap would otherwise silently under-report on the
// chain detail page's "Protocols" metric.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chainMetrics, chains, protocolChains, protocols } from "@/lib/database/schema";
import { getChainProtocolCounts, getGlobalTvlHistory } from "./chains";

const OVER_CAP_COUNT = 55;

describe("getChainProtocolCounts", () => {
  const createdChainIds: string[] = [];
  const createdProtocolIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
    if (createdProtocolIds.length > 0) {
      await db.delete(protocols).where(inArray(protocols.id, createdProtocolIds.splice(0)));
    }
  });

  it("reports the true count for a chain with more than 50 protocol associations, not the 50-row cap getChainBySlug's topProtocols uses", async () => {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const protocolRows = await db
      .insert(protocols)
      .values(
        Array.from({ length: OVER_CAP_COUNT }, (_, i) => ({
          name: `Test Protocol ${i} ${randomUUID()}`,
          slug: `test-protocol-${i}-${randomUUID()}`,
        })),
      )
      .returning({ id: protocols.id });
    createdProtocolIds.push(...protocolRows.map((p) => p.id));

    await db
      .insert(protocolChains)
      .values(protocolRows.map((p) => ({ protocolId: p.id, chainId: chain.id })));

    const counts = await getChainProtocolCounts([chain.id]);
    expect(counts.get(chain.id)).toBe(OVER_CAP_COUNT);
    // The bug this guards against: silently reporting the cap instead of
    // the real count.
    expect(counts.get(chain.id)).toBeGreaterThan(50);
  });

  it("returns an empty map for an empty chainIds array without querying", async () => {
    const counts = await getChainProtocolCounts([]);
    expect(counts.size).toBe(0);
  });
});

// Regression coverage for the Phase 4 historical-TVL audit's confirmed
// getGlobalTvlHistory bug: sum(tvl) over a day where every contributing
// chain_metrics row has a null tvl returns SQL NULL (Postgres aggregates
// ignore nulls, and produce one themselves only when nothing real
// remains) - the previous implementation ran `Number(r.tvl)` on that
// result unconditionally, and `Number(null) === 0` in JS, silently
// turning "no chain reported TVL that day" into a confident, wrong "$0"
// data point. computeTvlChanges and every RangedAreaChart caller already
// expect a nullable tvl point; this function was the one place breaking
// that contract.
//
// This queries the *entire* chain_metrics table with no scoping filter,
// so timestamps are pinned to a fixed date far in the future (mirrors
// protocols.test.ts's getGlobalMetricsHistory tests) - a day bucket
// guaranteed to contain nothing but what each test seeds, regardless of
// whatever real data already exists.
describe("getGlobalTvlHistory", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  async function makeChain() {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  it("reports null, not $0, for a day where every contributing row has a null tvl", async () => {
    const day = new Date("2099-07-20T00:00:00.000Z");
    const chainId = await makeChain();
    await db.insert(chainMetrics).values([{ chainId, timestamp: day, tvl: null }]);

    const history = await getGlobalTvlHistory();
    const point = history.find((h) => h.timestamp.getTime() === day.getTime());
    expect(point).toBeDefined();
    expect(point?.tvl).toBeNull();
    // The exact bug: the old implementation would have produced 0 here.
    expect(point?.tvl).not.toBe(0);
  });

  it("sums only the non-null rows on a day with a mix of null and real tvl", async () => {
    const day = new Date("2099-07-21T00:00:00.000Z");
    const chainA = await makeChain();
    const chainB = await makeChain();
    await db.insert(chainMetrics).values([
      { chainId: chainA, timestamp: day, tvl: null },
      { chainId: chainB, timestamp: day, tvl: "150.00" },
    ]);

    const history = await getGlobalTvlHistory();
    const point = history.find((h) => h.timestamp.getTime() === day.getTime());
    expect(point?.tvl).toBe(150);
  });

  it("sums real values normally on a day with no nulls", async () => {
    const day = new Date("2099-07-22T00:00:00.000Z");
    const chainA = await makeChain();
    const chainB = await makeChain();
    await db.insert(chainMetrics).values([
      { chainId: chainA, timestamp: day, tvl: "100.00" },
      { chainId: chainB, timestamp: day, tvl: "50.00" },
    ]);

    const history = await getGlobalTvlHistory();
    const point = history.find((h) => h.timestamp.getTime() === day.getTime());
    expect(point?.tvl).toBe(150);
  });
});

// A single file-level afterAll, not one per describe block - closeDb()
// tears down the shared connection every test file's `db` import points
// to, so closing it after the first describe finishes would leave the
// second describe's tests running queries against an already-closed
// connection (confirmed: this is exactly what happened before this was
// consolidated - CONNECTION_ENDED on every getGlobalTvlHistory test).
afterAll(async () => {
  await closeDb();
});
