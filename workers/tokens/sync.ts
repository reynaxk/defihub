import "dotenv/config";
import { closeDb, db } from "../../lib/database/client";
import { chains, tokenPrices, tokens } from "../../lib/database/schema";
import { tokenDiscoveryProvider } from "../../lib/providers";
import { ProviderUnavailableError } from "../../lib/providers/types";
import { COINGECKO_PLATFORM_TO_CHAIN_SLUG } from "../../lib/config/chains";

const TOP_N = 250;

export async function syncTokens() {
  const chainRows = await db.select().from(chains);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  let marketTokens;
  try {
    marketTokens = await tokenDiscoveryProvider.getTopMarketTokens(TOP_N);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      console.warn(`[tokens] provider unavailable, skipping this run: ${err.message}`);
      return;
    }
    throw err;
  }

  const now = new Date();
  let matched = 0;
  let priced = 0;

  for (const token of marketTokens) {
    for (const [platformId, address] of Object.entries(token.platforms)) {
      if (!address) continue; // CoinGecko sometimes lists a platform with an empty address

      const chainSlug = COINGECKO_PLATFORM_TO_CHAIN_SLUG.get(platformId);
      if (!chainSlug) continue; // not one of our 5 supported chains

      const chainId = chainIdBySlug.get(chainSlug);
      if (!chainId) continue;

      const [row] = await db
        .insert(tokens)
        .values({
          chainId,
          address,
          symbol: token.symbol,
          name: token.name,
          logoUrl: token.logoUrl,
          coingeckoId: token.coingeckoId,
        })
        .onConflictDoUpdate({
          target: [tokens.chainId, tokens.address],
          set: {
            symbol: token.symbol,
            name: token.name,
            logoUrl: token.logoUrl,
            coingeckoId: token.coingeckoId,
          },
        })
        .returning({ id: tokens.id });
      matched++;

      if (token.priceUsd != null) {
        await db
          .insert(tokenPrices)
          .values({
            tokenId: row.id,
            timestamp: now,
            priceUsd: token.priceUsd.toString(),
            marketCap: token.marketCap != null ? token.marketCap.toString() : null,
            volume24h: token.volume24h != null ? token.volume24h.toString() : null,
            priceChange24h: token.priceChange24h != null ? token.priceChange24h.toString() : null,
            priceChange7d: token.priceChange7d != null ? token.priceChange7d.toString() : null,
          })
          .onConflictDoNothing();
        priced++;
      }
    }
  }

  console.log(
    `[tokens] scanned ${marketTokens.length} market tokens, matched ${matched} chain deployments (${priced} priced)`,
  );
}

if (require.main === module) {
  syncTokens()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[tokens] sync failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
