import { and, eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokens } from "@/lib/database/schema";
import { REFERENCE_ASSETS, type ReferenceAsset } from "./config";

// Keeps a `tokens` row present for every configured reference asset, the
// same "config stays the source of truth, this makes it queryable as a real
// canonical row too" pattern as syncPoolsFromConfig/syncVaultsFromConfig
// (lib/onchain/pools.ts, vaults.ts) - upserted by (chainId, address), the
// same identity `tokens_chain_address_unique` already enforces for every
// other token row in this app. Deliberately NOT left to depend on
// workers/tokens/sync.ts's own CoinGecko-driven discovery happening first:
// that worker runs on its own schedule and discovers tokens by market-cap
// rank, which is an external, independent concern this on-chain pricing
// engine must not be silently gated on. Running both is safe and
// idempotent - whichever last writes a given (chainId, address) row wins,
// the same last-writer-wins upsert semantics every other config-sync
// function in this app already relies on.
export async function syncReferenceAssetTokens(assets: ReferenceAsset[] = REFERENCE_ASSETS): Promise<Map<string, string>> {
  const tokenIdByAssetKey = new Map<string, string>();
  if (assets.length === 0) return tokenIdByAssetKey;

  const chainRows = await db.select({ id: chains.id, slug: chains.slug }).from(chains);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  for (const asset of assets) {
    const chainId = chainIdBySlug.get(asset.chainSlug);
    if (!chainId) continue; // chain not yet synced - mirrors syncPoolsFromConfig's own skip for this case

    const [row] = await db
      .insert(tokens)
      .values({
        chainId,
        address: asset.address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        coingeckoId: asset.coingeckoId,
      })
      .onConflictDoUpdate({
        target: [tokens.chainId, tokens.address],
        set: { symbol: asset.symbol, decimals: asset.decimals, coingeckoId: asset.coingeckoId },
      })
      .returning({ id: tokens.id });

    tokenIdByAssetKey.set(asset.key, row.id);
  }

  return tokenIdByAssetKey;
}

// Looks up an already-synced reference asset's tokens.id without upserting
// - used by callers (e.g. a future TVL source-selection policy) that only
// need to read the id, not (re-)establish it.
export async function getReferenceAssetTokenId(chainSlug: string, address: string): Promise<string | null> {
  const [row] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(eq(chains.slug, chainSlug), eq(tokens.address, address.toLowerCase())));
  return row?.id ?? null;
}
