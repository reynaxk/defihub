import "dotenv/config";
import { isNotNull } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { tokenPrices, tokens } from "../../lib/database/schema";
import { priceProvider } from "../../lib/providers";
import { ProviderUnavailableError } from "../../lib/providers/types";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export async function syncPrices(): Promise<void> {
  await withSyncRun("prices", async () => {
    const trackedTokens = await db
      .select()
      .from(tokens)
      .where(isNotNull(tokens.coingeckoId));

    if (trackedTokens.length === 0) {
      logger.info("no tokens with a coingeckoId to sync", { component: "prices" });
      return { result: undefined, stats: { recordsProcessed: 0 } };
    }

    const ids = [...new Set(trackedTokens.map((t) => t.coingeckoId!))];

    let prices;
    try {
      prices = await priceProvider.getPrices(ids);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        logger.warn("provider unavailable, skipping this run", { component: "prices", error: err });
        return { result: undefined, stats: { recordsProcessed: 0, errorSummary: err.message }, outcome: "partial" as const };
      }
      throw err;
    }

    const priceById = new Map(prices.map((p) => [p.id, p]));
    const now = new Date();

    const rows = trackedTokens
      .map((token) => {
        const price = priceById.get(token.coingeckoId!);
        if (!price) return null;
        return {
          tokenId: token.id,
          timestamp: now,
          priceUsd: price.priceUsd.toString(),
          marketCap: price.marketCap != null ? price.marketCap.toString() : null,
          volume24h: price.volume24h != null ? price.volume24h.toString() : null,
          priceChange24h: price.priceChange24h != null ? price.priceChange24h.toString() : null,
        };
      })
      .filter((r) => r !== null);

    if (rows.length > 0) {
      await db.insert(tokenPrices).values(rows).onConflictDoNothing();
    }

    logger.info("sync complete", {
      component: "prices",
      recordsProcessed: rows.length,
      metadata: { trackedTokens: trackedTokens.length },
    });

    return {
      result: undefined,
      stats: { recordsProcessed: rows.length, metadata: { trackedTokens: trackedTokens.length } },
    };
  });
}

if (require.main === module) {
  syncPrices()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("sync failed", { component: "prices", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
