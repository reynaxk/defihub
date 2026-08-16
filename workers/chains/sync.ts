import "dotenv/config";
import { closeDb, db } from "../../lib/database/client";
import { chainMetrics, chains } from "../../lib/database/schema";
import { defiDataProvider } from "../../lib/providers";
import { chunk } from "../../lib/utils/chunk";

const BATCH_SIZE = 500;

export async function syncChains() {
  const chainRows = await db.select().from(chains);

  for (const chain of chainRows) {
    if (!chain.defillamaSlug) continue;

    const history = await defiDataProvider.getChainTvlHistory(chain.defillamaSlug);
    if (history.length === 0) {
      console.log(`[chains] no history for ${chain.name}`);
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

    console.log(`[chains] synced ${rows.length} historical points for ${chain.name}`);
  }
}

if (require.main === module) {
  syncChains()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[chains] sync failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
