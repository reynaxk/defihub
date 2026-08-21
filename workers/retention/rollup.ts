import "dotenv/config";
import { count, sql } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chainMetrics, protocolMetrics, tokenPrices } from "../../lib/database/schema";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

// Retention policy for the three append-only time-series tables
// (chain_metrics, protocol_metrics, token_prices), which otherwise grow
// forever at their sync cadence (hourly for chain/protocol metrics, every
// 15 min for token prices - see vercel.json's crons). Tiers chosen from
// actual usage, not an arbitrary example: computeTvlChanges
// (lib/database/queries/tvl-change.ts) only ever looks back 30 days, and no
// chart range needs native resolution beyond that to look correct - the
// homepage's own global TVL chart already trusts a daily bucket
// (getGlobalTvlHistory's date_trunc('day', ...) SUM).
//
//   < 30 days:    untouched, full native resolution
//   30-180 days:  token_prices only, downsampled to 1 row/hour (chain/
//                 protocol metrics are already <=hourly - nothing to do)
//   > 180 days:   all three tables, downsampled to 1 row/day
//
// Mechanism: keep-latest-per-bucket DELETE, not synthetic rollup rows - the
// single row that survives each bucket is a real historical snapshot, never
// a manufactured average. Each statement is self-contained and trivially
// idempotent (a second run finds nothing left to delete in an
// already-downsampled bucket) - re-running or retrying this worker can
// never corrupt data. It CAN still deadlock against itself, though: two
// concurrent invocations running the identical self-join DELETE can lock
// the same rows in a different order, which Postgres's deadlock detector
// resolves by aborting one of the two transactions. That's not data
// corruption, but it is a spurious failed run and wasted work under
// exactly the conditions (a slow run overlapping the next scheduled tick,
// or a platform cron retry after a timeout) most likely to trigger it - so
// a second concurrent invocation takes an advisory lock and bails out
// immediately instead of racing for row locks. See runRollup below.

const MID_TIER_DAYS = 30;
const OLD_TIER_DAYS = 180;

export interface RollupStats {
  chainMetrics: { before: number; after: number; deleted: number };
  protocolMetrics: { before: number; after: number; deleted: number };
  tokenPrices: { before: number; after: number; deleted: number };
}

// Test-only synchronization point - not used by the production call site
// (app/api/cron/rollup-metrics/route.ts calls rollupMetrics() with no
// arguments, so this is always undefined there). Exists so a test can
// commit a concurrent write at a moment guaranteed to fall strictly
// between the "before" counts and the first DELETE, without depending on
// Promise.all/setTimeout scheduling to land it there.
export interface RollupTestHooks {
  afterInitialCounts?: () => Promise<void>;
}

export async function rollupMetrics(testHooks?: RollupTestHooks): Promise<RollupStats | null> {
  return withSyncRun("rollup-metrics", async () => {
    const stats = await runRollup(testHooks);
    if (stats === null) {
      // Not a successful no-op run - the lock was already held elsewhere,
      // so this invocation did nothing at all. Without an explicit
      // outcome, withSyncRun's default ("success") would persist this
      // indistinguishably from "ran and genuinely found zero rows to
      // delete," hiding a lock-contended/skipped run from anyone reading
      // sync_runs.
      return {
        result: null,
        stats: { recordsProcessed: 0, metadata: { skipped: "already running elsewhere" } },
        outcome: "partial" as const,
      };
    }
    const totalRemoved = stats.chainMetrics.deleted + stats.protocolMetrics.deleted + stats.tokenPrices.deleted;
    return { result: stats, stats: { recordsProcessed: totalRemoved, metadata: { ...stats } } };
  });
}

// Arbitrary key, unique to this worker among this app's advisory-lock
// users (there are no others today). Transaction-scoped
// (pg_try_advisory_xact_lock, not the session-scoped pg_try_advisory_lock)
// so Postgres releases it automatically on COMMIT or ROLLBACK - no
// separate unlock call to get wrong, and no risk of the lock getting stuck
// on a pooled connection that a later unlock happens not to land back on
// (postgres.js's pool doesn't guarantee connection affinity across
// separate top-level queries, only within one transaction).
export const ROLLUP_ADVISORY_LOCK_KEY = 728140501;

async function runRollup(testHooks?: RollupTestHooks): Promise<RollupStats | null> {
  const stats = await db.transaction(async (tx) => {
    const [{ locked }] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${ROLLUP_ADVISORY_LOCK_KEY}) as locked`,
    );
    if (!locked) {
      logger.warn("rollup already in progress in another invocation, skipping this run", {
        component: "retention",
      });
      return null;
    }

    const before = {
      chainMetrics: (await tx.select({ value: count() }).from(chainMetrics))[0]?.value ?? 0,
      protocolMetrics: (await tx.select({ value: count() }).from(protocolMetrics))[0]?.value ?? 0,
      tokenPrices: (await tx.select({ value: count() }).from(tokenPrices))[0]?.value ?? 0,
    };

    await testHooks?.afterInitialCounts?.();

    // chain_metrics: keep the latest row per (chain, day) beyond the old tier.
    const chainMetricsResult = await tx.execute(sql`
      delete from chain_metrics a using chain_metrics b
      where a.chain_id = b.chain_id
        and date_trunc('day', a.timestamp at time zone 'utc') = date_trunc('day', b.timestamp at time zone 'utc')
        and a.timestamp < b.timestamp
        and a.timestamp < now() - make_interval(days => ${OLD_TIER_DAYS})
    `);

    // protocol_metrics: chain_id is null for aggregate (all-chains) rows, so
    // the bucket join needs IS NOT DISTINCT FROM rather than plain equality -
    // NULL = NULL is never true in SQL, which would otherwise treat every
    // pair of aggregate rows as belonging to different buckets.
    const protocolMetricsResult = await tx.execute(sql`
      delete from protocol_metrics a using protocol_metrics b
      where a.protocol_id = b.protocol_id
        and a.chain_id is not distinct from b.chain_id
        and date_trunc('day', a.timestamp at time zone 'utc') = date_trunc('day', b.timestamp at time zone 'utc')
        and a.timestamp < b.timestamp
        and a.timestamp < now() - make_interval(days => ${OLD_TIER_DAYS})
    `);

    // token_prices, mid tier: keep the latest row per (token, hour) strictly
    // within the 30-180 day window. Bounded on both sides so this pass never
    // touches rows the daily tier below is responsible for.
    const tokenPricesMidTierResult = await tx.execute(sql`
      delete from token_prices a using token_prices b
      where a.token_id = b.token_id
        and date_trunc('hour', a.timestamp at time zone 'utc') = date_trunc('hour', b.timestamp at time zone 'utc')
        and a.timestamp < b.timestamp
        and a.timestamp < now() - make_interval(days => ${MID_TIER_DAYS})
        and a.timestamp >= now() - make_interval(days => ${OLD_TIER_DAYS})
    `);

    // token_prices, old tier: keep the latest row per (token, day) beyond 180
    // days - applies whether or not the mid tier already ran on these rows in
    // a prior invocation.
    const tokenPricesOldTierResult = await tx.execute(sql`
      delete from token_prices a using token_prices b
      where a.token_id = b.token_id
        and date_trunc('day', a.timestamp at time zone 'utc') = date_trunc('day', b.timestamp at time zone 'utc')
        and a.timestamp < b.timestamp
        and a.timestamp < now() - make_interval(days => ${OLD_TIER_DAYS})
    `);

    const after = {
      chainMetrics: (await tx.select({ value: count() }).from(chainMetrics))[0]?.value ?? 0,
      protocolMetrics: (await tx.select({ value: count() }).from(protocolMetrics))[0]?.value ?? 0,
      tokenPrices: (await tx.select({ value: count() }).from(tokenPrices))[0]?.value ?? 0,
    };

    // recordsProcessed (via `deleted` below) comes from each DELETE's own
    // affected-row count (postgres.js attaches this as `.count` on the
    // result of a non-SELECT statement), not from the before/after count
    // deltas above - those deltas only hold under an isolation level that
    // guarantees no concurrent writer touched these tables mid-transaction,
    // which Postgres's default READ COMMITTED does not: chain/protocol/
    // token sync workers write to these same tables without taking
    // ROLLUP_ADVISORY_LOCK_KEY (that lock only ever needed to serialize
    // against another rollup, not every writer), so a concurrent insert
    // between the before/after counts could mask exactly how many rows
    // this run itself removed. before/after are kept for observability
    // (they still show the table's overall size trend), just no longer
    // used to compute the reported count.
    const result: RollupStats = {
      chainMetrics: { before: before.chainMetrics, after: after.chainMetrics, deleted: chainMetricsResult.count ?? 0 },
      protocolMetrics: {
        before: before.protocolMetrics,
        after: after.protocolMetrics,
        deleted: protocolMetricsResult.count ?? 0,
      },
      tokenPrices: {
        before: before.tokenPrices,
        after: after.tokenPrices,
        deleted: (tokenPricesMidTierResult.count ?? 0) + (tokenPricesOldTierResult.count ?? 0),
      },
    };

    return result;
  });

  // Logged only after the transaction promise resolves, meaning COMMIT
  // actually succeeded - logging "complete" from inside the callback would
  // fire even if COMMIT itself then failed and rolled back every DELETE,
  // leaving operators comparing a "complete" log against row counts that
  // never changed. Guarded against null too - the lock-contended/skipped
  // path already logs its own "already in progress" warning above and
  // never ran a rollup at all, so "complete" would be inaccurate there.
  if (stats) {
    logger.info("rollup complete", { component: "retention", metadata: stats });
  }

  return stats;
}

if (require.main === module) {
  rollupMetrics()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("rollup failed", { component: "retention", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
