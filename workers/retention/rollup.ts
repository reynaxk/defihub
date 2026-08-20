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
// already-downsampled bucket), so this is safe to re-run, retry, or run
// concurrently with itself without corrupting anything.

const MID_TIER_DAYS = 30;
const OLD_TIER_DAYS = 180;

export interface RollupStats {
  chainMetrics: { before: number; after: number };
  protocolMetrics: { before: number; after: number };
  tokenPrices: { before: number; after: number };
}

async function rowCount(table: typeof chainMetrics | typeof protocolMetrics | typeof tokenPrices): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

export async function rollupMetrics(): Promise<RollupStats> {
  return withSyncRun("rollup-metrics", async () => {
    const stats = await runRollup();
    const totalRemoved =
      stats.chainMetrics.before -
      stats.chainMetrics.after +
      (stats.protocolMetrics.before - stats.protocolMetrics.after) +
      (stats.tokenPrices.before - stats.tokenPrices.after);
    return { result: stats, stats: { recordsProcessed: totalRemoved, metadata: { ...stats } } };
  });
}

async function runRollup(): Promise<RollupStats> {
  const before = {
    chainMetrics: await rowCount(chainMetrics),
    protocolMetrics: await rowCount(protocolMetrics),
    tokenPrices: await rowCount(tokenPrices),
  };

  // chain_metrics: keep the latest row per (chain, day) beyond the old tier.
  await db.execute(sql`
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
  await db.execute(sql`
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
  await db.execute(sql`
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
  await db.execute(sql`
    delete from token_prices a using token_prices b
    where a.token_id = b.token_id
      and date_trunc('day', a.timestamp at time zone 'utc') = date_trunc('day', b.timestamp at time zone 'utc')
      and a.timestamp < b.timestamp
      and a.timestamp < now() - make_interval(days => ${OLD_TIER_DAYS})
  `);

  const after = {
    chainMetrics: await rowCount(chainMetrics),
    protocolMetrics: await rowCount(protocolMetrics),
    tokenPrices: await rowCount(tokenPrices),
  };

  const stats: RollupStats = {
    chainMetrics: { before: before.chainMetrics, after: after.chainMetrics },
    protocolMetrics: { before: before.protocolMetrics, after: after.protocolMetrics },
    tokenPrices: { before: before.tokenPrices, after: after.tokenPrices },
  };

  logger.info("rollup complete", { component: "retention", metadata: stats });

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
