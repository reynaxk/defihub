import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { indexAllPoolVolume, type PoolVolumeRunResult } from "../../lib/onchain/volume/engine";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export interface VolumeRunSummary {
  succeeded: number;
  failed: number;
  totalSwaps: number;
  outcome: "success" | "partial";
}

// Pure - the exact same shape/purpose as summarizePriceResults
// (workers/onchain/price.ts): turns per-pool results into the run's
// overall stats and success/partial classification, directly unit-testable
// with plain constructed inputs (see volume.test.ts). "success" requires
// every configured pool to have indexed cleanly this run - a pool that
// failed outright (bad RPC read, DB error) makes the whole run "partial,"
// visible in /api/cron/health, even though every OTHER pool's indexing
// still committed.
export function summarizeVolumeResults(results: PoolVolumeRunResult[]): VolumeRunSummary {
  let succeeded = 0;
  let failed = 0;
  let totalSwaps = 0;

  for (const r of results) {
    if (r.ok) {
      succeeded++;
      totalSwaps += r.swapCount ?? 0;
    } else {
      failed++;
    }
  }

  return { succeeded, failed, totalSwaps, outcome: failed === 0 ? "success" : "partial" };
}

// Phase 5.4's native volume/fees/revenue indexer, run as its own worker -
// same withSyncRun/logger pattern as price.ts, its own "onchain-volume"
// sync_runs name so a failure here is independently visible in
// /api/cron/health rather than blurred into price.ts's or verify.ts's own
// success rate.
export async function indexOnchainVolume(): Promise<void> {
  await withSyncRun("onchain-volume", async () => {
    const results = await indexAllPoolVolume();
    for (const r of results) {
      if (r.ok) {
        logger.info("volume indexed", {
          component: "onchain-volume",
          pool: r.poolKey,
          swapCount: r.swapCount,
          pricedSwapCount: r.pricedSwapCount,
          unpricedSwapCount: r.unpricedSwapCount,
          volumeUsd: r.volumeUsd,
          feesUsd: r.feesUsd,
          revenueOutcome: r.revenueOutcome,
          qualityFlags: r.qualityFlags,
        });
      } else {
        logger.warn("volume indexing failed for pool", { component: "onchain-volume", pool: r.poolKey, reason: r.error });
      }
    }

    const summary = summarizeVolumeResults(results);
    return {
      result: undefined,
      stats: {
        recordsProcessed: summary.totalSwaps,
        errorCount: summary.failed,
        metadata: { succeeded: summary.succeeded, failed: summary.failed, poolsConsidered: results.length },
      },
      outcome: summary.outcome,
    };
  });
}

if (require.main === module) {
  indexOnchainVolume()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("volume indexing failed", { component: "onchain-volume", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
