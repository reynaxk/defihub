// Real-Postgres integration test for getGlobalMetricsHistory's overcounting
// fix. protocol_metrics' aggregate (chainId null) rows accumulate a brand
// new, distinct-timestamp row every hourly sync-protocols cron tick (see
// workers/protocols/sync.ts - `timestamp: new Date()`, no dedup by day),
// unlike chain_metrics' DefiLlama-backfilled, already-daily history. A
// naive `SUM(volume24h) GROUP BY day` over every row in a day would sum
// multiple overlapping 24h-trailing snapshots of the same protocol together
// - this test seeds exactly that scenario (multiple same-day rows per
// protocol, with deliberately different values per row) and asserts only
// the latest row per protocol per day is counted.
//
// Timestamps are pinned to a fixed date far in the future (no real cron
// ever writes `timestamp: new Date()` there) rather than "N days ago" -
// getGlobalMetricsHistory sums *every* protocol in the table with no id
// filter, so the assertions below need a day bucket guaranteed to contain
// nothing but what this test seeds, regardless of whatever else exists in
// the database it runs against.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, protocolMetrics, protocols } from "@/lib/database/schema";
import { getGlobalMetricsHistory } from "./protocols";

const DAY_1 = new Date("2099-06-15T00:00:00.000Z");
const DAY_2 = new Date("2099-06-16T00:00:00.000Z");

function atHour(day: Date, hour: number): Date {
  const d = new Date(day);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

describe("getGlobalMetricsHistory", () => {
  const createdProtocolIds: string[] = [];
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProtocolIds.splice(0)) await db.delete(protocols).where(eq(protocols.id, id));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeProtocol() {
    const [protocol] = await db
      .insert(protocols)
      .values({ name: `Test Protocol ${randomUUID()}`, slug: `test-protocol-${randomUUID()}` })
      .returning({ id: protocols.id });
    createdProtocolIds.push(protocol.id);
    return protocol.id;
  }

  it("sums only the latest same-day row per protocol, not every hourly snapshot", async () => {
    const protocolA = await makeProtocol();
    const protocolB = await makeProtocol();

    await db.insert(protocolMetrics).values([
      // Protocol A: 3 same-day snapshots (simulating 3 hourly sync ticks).
      // Only the hour-18 (latest) row should count toward day 1.
      { protocolId: protocolA, chainId: null, timestamp: atHour(DAY_1, 2), volume24h: "100", fees24h: "10", revenue24h: "1" },
      { protocolId: protocolA, chainId: null, timestamp: atHour(DAY_1, 10), volume24h: "150", fees24h: "15", revenue24h: "1.5" },
      { protocolId: protocolA, chainId: null, timestamp: atHour(DAY_1, 18), volume24h: "200", fees24h: "20", revenue24h: "2" },
      // Protocol B: 2 same-day snapshots - only hour-20 (latest) should count.
      { protocolId: protocolB, chainId: null, timestamp: atHour(DAY_1, 5), volume24h: "50", fees24h: "5", revenue24h: "0.5" },
      { protocolId: protocolB, chainId: null, timestamp: atHour(DAY_1, 20), volume24h: "80", fees24h: "8", revenue24h: "0.8" },
      // Protocol A again on day 2 - must land in a separate bucket, not
      // merged into day 1's total.
      { protocolId: protocolA, chainId: null, timestamp: atHour(DAY_2, 3), volume24h: "300", fees24h: "30", revenue24h: "3" },
    ]);

    const history = await getGlobalMetricsHistory();
    const day1 = history.find((h) => h.timestamp.getTime() === DAY_1.getTime());
    const day2 = history.find((h) => h.timestamp.getTime() === DAY_2.getTime());

    // Correct: latest-per-protocol (200 + 80 = 280), not every row summed
    // (100+150+200+50+80 = 580, what the pre-fix query would have returned).
    expect(day1?.volume24h).toBe(280);
    expect(day1?.fees24h).toBe(28);
    expect(day1?.revenue24h).toBeCloseTo(2.8);

    expect(day2?.volume24h).toBe(300);
    expect(day2?.fees24h).toBe(30);
    expect(day2?.revenue24h).toBeCloseTo(3);
  });

  it("excludes per-chain rows, counting only each protocol's aggregate row", async () => {
    const protocol = await makeProtocol();
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    await db.insert(protocolMetrics).values([
      { protocolId: protocol, chainId: null, timestamp: atHour(DAY_1, 12), volume24h: "40", fees24h: "4", revenue24h: "0.4" },
      // A per-chain row at a huge value - must not leak into the global
      // total, which should only ever count the chainId-null aggregate row.
      { protocolId: protocol, chainId: chain.id, timestamp: atHour(DAY_1, 12), volume24h: "999999", fees24h: "99999", revenue24h: "9999" },
    ]);

    const history = await getGlobalMetricsHistory();
    const day1 = history.find((h) => h.timestamp.getTime() === DAY_1.getTime());

    expect(day1?.volume24h).toBe(40);
    expect(day1?.fees24h).toBe(4);
    expect(day1?.revenue24h).toBeCloseTo(0.4);
  });
});
