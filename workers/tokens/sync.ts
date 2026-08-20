import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chains, tokenPrices, tokens } from "../../lib/database/schema";
import { tokenDiscoveryProvider } from "../../lib/providers";
import { ProviderUnavailableError } from "../../lib/providers/types";
import { COINGECKO_PLATFORM_TO_CHAIN_SLUG } from "../../lib/config/chains";
import { chunk } from "../../lib/utils/chunk";
import { fetchOnchainDecimals } from "../../lib/chains/token-decimals";

const TOP_N = 250;
const BATCH_SIZE = 500;

interface TokenDeployment {
  chainId: string;
  address: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  coingeckoId: string;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
}

export async function syncTokens() {
  const chainRows = await db.select().from(chains);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));
  const chainSlugById = new Map(chainRows.map((c) => [c.id, c.slug]));

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

  // Flatten to one row per (token, chain deployment) with no DB calls in
  // this loop - up to 250 tokens x up to 8 chains each is small enough to
  // hold entirely in memory before batching writes below.
  const deployments: TokenDeployment[] = [];
  for (const token of marketTokens) {
    for (const [platformId, address] of Object.entries(token.platforms)) {
      if (!address) continue; // CoinGecko sometimes lists a platform with an empty address

      const chainSlug = COINGECKO_PLATFORM_TO_CHAIN_SLUG.get(platformId);
      if (!chainSlug) continue; // not one of our supported chains

      const chainId = chainIdBySlug.get(chainSlug);
      if (!chainId) continue;

      deployments.push({
        chainId,
        address,
        symbol: token.symbol,
        name: token.name,
        logoUrl: token.logoUrl,
        coingeckoId: token.coingeckoId,
        priceUsd: token.priceUsd,
        marketCap: token.marketCap,
        volume24h: token.volume24h,
        priceChange24h: token.priceChange24h,
        priceChange7d: token.priceChange7d,
      });
    }
  }

  // 1. Resolve real decimals via one multicall per chain, batching every
  // deployment on that chain into a single RPC round trip. A chain with no
  // viem/RPC config (non-EVM) or a chain whose RPC call fails outright
  // simply contributes no entries here - those tokens' decimals stay
  // unknown (null) rather than falling back to a guessed value. Per-address
  // read failures within a successful multicall are handled the same way
  // inside fetchOnchainDecimals itself.
  const addressesByChainId = new Map<string, Set<string>>();
  for (const d of deployments) {
    const set = addressesByChainId.get(d.chainId) ?? new Set<string>();
    set.add(d.address);
    addressesByChainId.set(d.chainId, set);
  }

  const decimalsByKey = new Map<string, number>();
  await Promise.all(
    [...addressesByChainId.entries()].map(async ([chainId, addressSet]) => {
      const slug = chainSlugById.get(chainId);
      if (!slug) return;
      try {
        const resolved = await fetchOnchainDecimals(slug, [...addressSet]);
        for (const [address, decimals] of resolved) {
          decimalsByKey.set(`${chainId}|${address}`, decimals);
        }
      } catch (err) {
        console.warn(`[tokens] decimals read failed for chain "${slug}", leaving unknown:`, err);
      }
    }),
  );

  // 2. Bulk upsert tokens. RETURNING gives back one row per input tuple
  // (inserted or updated), which is enough to resolve each deployment's row
  // id without a second round of SELECTs - keyed by the exact chainId+address
  // just written rather than relying on any positional correspondence to
  // the input array (batch INSERT...RETURNING doesn't guarantee that order).
  const tokenIdByKey = new Map<string, string>();
  for (const batch of chunk(deployments, BATCH_SIZE)) {
    const rows = await db
      .insert(tokens)
      .values(
        batch.map((d) => ({
          chainId: d.chainId,
          address: d.address,
          symbol: d.symbol,
          name: d.name,
          logoUrl: d.logoUrl,
          coingeckoId: d.coingeckoId,
          decimals: decimalsByKey.get(`${d.chainId}|${d.address}`) ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [tokens.chainId, tokens.address],
        // Each conflicting row needs ITS OWN new value, not a single JS
        // constant shared across the whole batch - excluded.<col> refers to
        // the specific row's proposed values within this multi-row INSERT,
        // unlike a literal like `symbol: someToken.symbol` would.
        set: {
          symbol: sql`excluded.symbol`,
          name: sql`excluded.name`,
          logoUrl: sql`excluded.logo_url`,
          coingeckoId: sql`excluded.coingecko_id`,
          // Prefer this run's freshly-read value, but never regress an
          // already-confirmed decimals value to null just because this
          // run's RPC call happened to fail - COALESCE keeps whatever's
          // already stored when the new value is null.
          decimals: sql`coalesce(excluded.decimals, ${tokens.decimals})`,
        },
      })
      .returning({ id: tokens.id, chainId: tokens.chainId, address: tokens.address });

    for (const row of rows) {
      tokenIdByKey.set(`${row.chainId}|${row.address}`, row.id);
    }
  }

  // 3. Bulk insert prices for every deployment that has one.
  const priceRows = deployments
    .filter((d): d is TokenDeployment & { priceUsd: number } => d.priceUsd != null)
    .map((d) => {
      const tokenId = tokenIdByKey.get(`${d.chainId}|${d.address}`);
      if (!tokenId) return null;
      return {
        tokenId,
        timestamp: now,
        priceUsd: d.priceUsd.toString(),
        marketCap: d.marketCap != null ? d.marketCap.toString() : null,
        volume24h: d.volume24h != null ? d.volume24h.toString() : null,
        priceChange24h: d.priceChange24h != null ? d.priceChange24h.toString() : null,
        priceChange7d: d.priceChange7d != null ? d.priceChange7d.toString() : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  for (const batch of chunk(priceRows, BATCH_SIZE)) {
    if (batch.length === 0) continue;
    await db.insert(tokenPrices).values(batch).onConflictDoNothing();
  }

  console.log(
    `[tokens] scanned ${marketTokens.length} market tokens, matched ${deployments.length} chain deployments (${priceRows.length} priced)`,
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
