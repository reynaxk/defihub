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

    for (const chain of chainRows) {
      if (!chain.defillamaSlug) continue;

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
    }

    return {
      result: undefined,
      stats: {
        recordsProcessed: totalPoints,
        metadata: { chainsSynced, chainsTotal: chainRows.length },
      },
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
