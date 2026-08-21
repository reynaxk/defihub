import "dotenv/config";
import { closeDb, db } from "../../lib/database/client";
import { chainMetrics, chains } from "../../lib/database/schema";
import { defiDataProvider } from "../../lib/providers";
import { chunk } from "../../lib/utils/chunk";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

const BATCH_SIZE = 500;

export async function syncChains(): Promise<void> {
  await withSyncRun("chains", async () => {
    const chainRows = await db.select().from(chains);
    let totalPoints = 0;
    let chainsSynced = 0;
    // Each chain's history fetch + insert is independent - one chain
    // temporarily failing (a DefiLlama blip, a malformed response for that
    // one slug) must not block every other chain for this entire cron
    // tick. Isolated per chain rather than left to abort the whole loop,
    // which previously meant one bad chain silently starved the rest until
    // the next scheduled run.
    const failedChains: string[] = [];

    for (const chain of chainRows) {
      if (!chain.defillamaSlug) continue;

      try {
        const history = await defiDataProvider.getChainTvlHistory(chain.defillamaSlug);
        if (history.length === 0) {
          logger.info("no history for chain", { component: "chains", chain: chain.name });
          continue;
        }

        const rows = history.map((point) => ({
          chainId: chain.id,
          timestamp: point.timestamp,
          tvl: point.tvl.toString(),
        }));

        for (const batch of chunk(rows, BATCH_SIZE)) {
          await db.insert(chainMetrics).values(batch).onConflictDoNothing();
        }

        totalPoints += rows.length;
        chainsSynced++;
        logger.info("synced historical points for chain", {
          component: "chains",
          chain: chain.name,
          recordsProcessed: rows.length,
        });
      } catch (err) {
        failedChains.push(chain.name);
        logger.warn("failed to sync chain, continuing with the rest", {
          component: "chains",
          chain: chain.name,
          error: err,
        });
      }
    }

    return {
      result: undefined,
      stats: {
        recordsProcessed: totalPoints,
        errorCount: failedChains.length,
        errorSummary: failedChains.length > 0 ? `failed chains: ${failedChains.join(", ")}` : undefined,
        metadata: { chainsSynced, chainsTotal: chainRows.length },
      },
      outcome: failedChains.length > 0 ? ("partial" as const) : ("success" as const),
    };
  });
}

if (require.main === module) {
  syncChains()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("sync failed", { component: "chains", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
