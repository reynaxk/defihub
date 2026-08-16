import "dotenv/config";
import { isNotNull } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { tokenPrices, tokens } from "../../lib/database/schema";
import { priceProvider } from "../../lib/providers";
import { ProviderUnavailableError } from "../../lib/providers/types";

export async function syncPrices() {
  const trackedTokens = await db
    .select()
    .from(tokens)
    .where(isNotNull(tokens.coingeckoId));

  if (trackedTokens.length === 0) {
    console.log("[prices] no tokens with a coingeckoId to sync");
    return;
  }

  const ids = [...new Set(trackedTokens.map((t) => t.coingeckoId!))];

  let prices;
  try {
    prices = await priceProvider.getPrices(ids);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      console.warn(`[prices] provider unavailable, skipping this run: ${err.message}`);
      return;
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

  console.log(`[prices] synced ${rows.length}/${trackedTokens.length} tracked tokens`);
}

if (require.main === module) {
  syncPrices()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[prices] sync failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
