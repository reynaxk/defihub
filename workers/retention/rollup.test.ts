// Real-Postgres integration tests, same reasoning as
// lib/security/rate-limit.test.ts: the keep-latest-per-bucket DELETE
// statements are the actual thing under test, not mockable behavior. Every
// test creates its own chain/protocol/token row (unique per test) and only
// asserts on rows scoped to that row's id, so this is safe to run
// regardless of whatever else already exists in the database.
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols, syncRuns, tokenPrices, tokens } from "@/lib/database/schema";
import { ROLLUP_ADVISORY_LOCK_KEY, rollupMetrics } from "./rollup";

// Timestamps are built from a fixed UTC date/hour rather than
// `now - N days - offsetMs`, so multiple "same bucket" points are
// guaranteed to land in the exact same day/hour bucket regardless of what
// time of day the test happens to run at - subtracting a raw offset from
// `now` can silently cross a UTC midnight or hour boundary depending on the
// current wall clock, which would make the test flaky rather than wrong.

function oldDayTimestamp(daysAgo: number, hourOfDay: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourOfDay, 0, 0, 0);
  return d;
}

function oldHourTimestamp(daysAgo: number, minuteOfHour: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCMinutes(minuteOfHour, 0, 0);
  return d;
}

function recentTimestamp(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function makeChain() {
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
    .returning({ id: chains.id });
  return chain.id;
}

describe("rollupMetrics", () => {
  const createdChainIds: string[] = [];
  const createdProtocolIds: string[] = [];
  const createdTokenIds: string[] = [];

  afterEach(async () => {
    // Metrics/prices cascade-delete with their parent row (schema.ts), so
    // removing the chain/protocol/token cleans up everything seeded below.
    for (const id of createdTokenIds.splice(0)) await db.delete(tokens).where(eq(tokens.id, id));
    for (const id of createdProtocolIds.splice(0)) await db.delete(protocols).where(eq(protocols.id, id));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("downsamples chain_metrics beyond 180 days to the latest row per day, leaving recent rows untouched", async () => {
    const chainId = await makeChain();
    createdChainIds.push(chainId);

    await db.insert(chainMetrics).values([
      { chainId, timestamp: oldDayTimestamp(200, 2), tvl: "100.00" },
      { chainId, timestamp: oldDayTimestamp(200, 10), tvl: "200.00" },
      { chainId, timestamp: oldDayTimestamp(200, 18), tvl: "300.00" }, // latest of the day - should survive
      { chainId, timestamp: recentTimestamp(1), tvl: "999.00" }, // untouched
    ]);

    await rollupMetrics();

    const rows = await db
      .select()
      .from(chainMetrics)
      .where(eq(chainMetrics.chainId, chainId))
      .orderBy(chainMetrics.timestamp);

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].tvl)).toBe(300);
    expect(Number(rows[1].tvl)).toBe(999);
  });

  it("is idempotent - a second run makes no further change", async () => {
    const chainId = await makeChain();
    createdChainIds.push(chainId);

    await db.insert(chainMetrics).values([
      { chainId, timestamp: oldDayTimestamp(200, 4), tvl: "100.00" },
      { chainId, timestamp: oldDayTimestamp(200, 16), tvl: "200.00" },
    ]);

    await rollupMetrics();
    const afterFirst = await db.select().from(chainMetrics).where(eq(chainMetrics.chainId, chainId));
    expect(afterFirst).toHaveLength(1);

    await rollupMetrics();
    const afterSecond = await db.select().from(chainMetrics).where(eq(chainMetrics.chainId, chainId));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });

  it("downsamples protocol_metrics beyond 180 days per bucket, handling null chain_id aggregate rows", async () => {
    const [protocol] = await db
      .insert(protocols)
      .values({ name: `Test Protocol ${randomUUID()}`, slug: `test-protocol-${randomUUID()}` })
      .returning({ id: protocols.id });
    createdProtocolIds.push(protocol.id);

    await db.insert(protocolMetrics).values([
      { protocolId: protocol.id, chainId: null, timestamp: oldDayTimestamp(200, 4), tvl: "100.00" },
      { protocolId: protocol.id, chainId: null, timestamp: oldDayTimestamp(200, 16), tvl: "200.00" }, // survives
      { protocolId: protocol.id, chainId: null, timestamp: recentTimestamp(1), tvl: "999.00" }, // untouched
    ]);

    await rollupMetrics();

    const rows = await db
      .select()
      .from(protocolMetrics)
      .where(eq(protocolMetrics.protocolId, protocol.id))
      .orderBy(protocolMetrics.timestamp);

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].tvl)).toBe(200);
    expect(Number(rows[1].tvl)).toBe(999);
  });

  it("downsamples token_prices to hourly in the 30-180 day window and to daily beyond 180 days", async () => {
    const chainId = await makeChain();
    createdChainIds.push(chainId);

    const [token] = await db
      .insert(tokens)
      .values({ chainId, address: `0xtest${randomUUID().slice(0, 8)}`, symbol: "TST" })
      .returning({ id: tokens.id });
    createdTokenIds.push(token.id);

    await db.insert(tokenPrices).values([
      // Mid tier (60 days old): three snapshots inside the same UTC hour.
      { tokenId: token.id, timestamp: oldHourTimestamp(60, 5), priceUsd: "1.00" },
      { tokenId: token.id, timestamp: oldHourTimestamp(60, 25), priceUsd: "2.00" },
      { tokenId: token.id, timestamp: oldHourTimestamp(60, 50), priceUsd: "3.00" }, // latest - survives
      // Old tier (200 days old): three snapshots on the same UTC day.
      { tokenId: token.id, timestamp: oldDayTimestamp(200, 2), priceUsd: "10.00" },
      { tokenId: token.id, timestamp: oldDayTimestamp(200, 10), priceUsd: "20.00" },
      { tokenId: token.id, timestamp: oldDayTimestamp(200, 18), priceUsd: "30.00" }, // latest - survives
      // Recent, untouched.
      { tokenId: token.id, timestamp: recentTimestamp(1), priceUsd: "999.00" },
    ]);

    await rollupMetrics();

    const rows = await db
      .select()
      .from(tokenPrices)
      .where(eq(tokenPrices.tokenId, token.id))
      .orderBy(tokenPrices.timestamp);

    expect(rows).toHaveLength(3);
    expect(Number(rows[0].priceUsd)).toBe(30); // old-tier day bucket
    expect(Number(rows[1].priceUsd)).toBe(3); // mid-tier hour bucket
    expect(Number(rows[2].priceUsd)).toBe(999); // recent
  });

  it("leaves rows inside the 30-day window untouched even with multiple same-day snapshots", async () => {
    const chainId = await makeChain();
    createdChainIds.push(chainId);

    await db.insert(chainMetrics).values([
      { chainId, timestamp: recentTimestamp(5.2), tvl: "1.00" },
      { chainId, timestamp: recentTimestamp(5.1), tvl: "2.00" },
    ]);

    await rollupMetrics();

    const rows = await db.select().from(chainMetrics).where(eq(chainMetrics.chainId, chainId));
    expect(rows).toHaveLength(2);
  });

  it("reports recordsProcessed from actual deleted rows, unaffected by a concurrent insert into the same table", async () => {
    const chainId = await makeChain();
    createdChainIds.push(chainId);

    // 3 rows in one old-tier day bucket - exactly 2 must be deleted (the
    // latest survives). Known, exact expected count, independent of
    // whatever else is happening in the table concurrently.
    await db.insert(chainMetrics).values([
      { chainId, timestamp: oldDayTimestamp(200, 2), tvl: "100.00" },
      { chainId, timestamp: oldDayTimestamp(200, 10), tvl: "200.00" },
      { chainId, timestamp: oldDayTimestamp(200, 18), tvl: "300.00" }, // latest - survives
    ]);

    // An independent raw connection (not the app's own pooled client,
    // which caps at 1 connection outside production and so can't overlap
    // with the rollup's own transaction) inserts a brand-new, recent row
    // concurrently with the rollup running. Under the old before/after
    // count-delta approach, this insert would land between the "before"
    // and "after" SELECT COUNT(*) and mask exactly how many rows this run
    // deleted (before=N, after=N+1-2=N-1, delta=1, not the real 2).
    const concurrentConn = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      const [result] = await Promise.all([
        rollupMetrics(),
        concurrentConn`insert into chain_metrics (chain_id, "timestamp", tvl) values (${chainId}, now(), '999.00')`,
      ]);

      expect(result?.chainMetrics.deleted).toBe(2);
    } finally {
      await concurrentConn.end();
    }

    const rows = await db.select().from(chainMetrics).where(eq(chainMetrics.chainId, chainId));
    // The 1 surviving old-tier row + the 1 concurrently-inserted recent row.
    expect(rows).toHaveLength(2);
  });

  // rollupMetrics() itself can't be exercised for genuine concurrency in
  // this test suite: the app's shared `db` client pools at most 1
  // connection outside production (lib/database/client.ts), so two
  // `Promise.all`'d calls through it would simply queue rather than run
  // concurrently, and the second would find the lock already released by
  // the time it starts - silently passing without testing anything. This
  // opens two independent raw connections instead, directly proving the
  // exact advisory-lock primitive runRollup uses (same key, same
  // transaction-scoped function) blocks a second session while the first
  // holds it.
  it("blocks a second session from acquiring the same transaction-scoped advisory lock", async () => {
    const connA = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const connB = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

    try {
      await connA.begin(async (txA) => {
        const [{ locked: lockedA }] = await txA`select pg_try_advisory_xact_lock(${ROLLUP_ADVISORY_LOCK_KEY}) as locked`;
        expect(lockedA).toBe(true);

        // A second, independent session tries for the identical key while
        // the first still holds it inside an open transaction.
        const [{ locked: lockedB }] =
          await connB`select pg_try_advisory_xact_lock(${ROLLUP_ADVISORY_LOCK_KEY}) as locked`;
        expect(lockedB).toBe(false);
      });

      // Released on COMMIT - a session acquiring it afterward succeeds.
      const [{ locked: lockedAfterCommit }] =
        await connB`select pg_try_advisory_xact_lock(${ROLLUP_ADVISORY_LOCK_KEY}) as locked`;
      expect(lockedAfterCommit).toBe(true);
    } finally {
      await connA.end();
      await connB.end();
    }
  });

  it("reports a lock-contended run as a null, non-null-distinguishable, partial sync run - not an undifferentiated success", async () => {
    // Holds the real lock on an independent raw connection (same
    // reasoning as the test above - the app's own pooled client can't
    // exercise genuine concurrency), then calls the actual public
    // rollupMetrics() entry point while it's held.
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      await holder.begin(async (tx) => {
        const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${ROLLUP_ADVISORY_LOCK_KEY}) as locked`;
        expect(locked).toBe(true);

        const result = await rollupMetrics();
        expect(result).toBeNull();
      });

      const [run] = await db
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.worker, "rollup-metrics"))
        .orderBy(desc(syncRuns.startedAt))
        .limit(1);
      expect(run.status).toBe("partial");
      expect(run.recordsProcessed).toBe(0);
    } finally {
      await holder.end();
    }
  });
});
