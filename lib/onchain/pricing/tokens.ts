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

// Phase 5.13: the dynamic-pricing engine's own twin of syncReferenceAssetTokens
// above, for a token discovered on-chain (lib/onchain/discovery/) rather
// than hand-configured. recordTokenPriceObservation (record-price-observation.ts)
// refuses to write a price observation without a real tokens.id - an
// arbitrary discovered-pool token has no reason to already have one
// (workers/tokens/sync.ts only ever discovers CoinGecko's own top-market-cap
// list, and the overwhelming majority of discovered-pool tokens are far
// outside it), so the dynamic pricing engine must be able to establish this
// row itself, the same way syncReferenceAssetTokens already does for its
// own 7 hand-curated tokens.
//
// Deliberately NOT identical to that function's own upsert: symbol/decimals
// here come from an on-chain decimals()/symbol() read (register.ts's own
// validated discovery data - see this function's own caller), which is
// exact and safe to overwrite on conflict, matching syncReferenceAssetTokens'
// own "last write wins" policy for those two columns. coingeckoId is
// deliberately excluded from the update set (never set to null on
// conflict): this function has no CoinGecko identity for the token at all,
// and a row that already exists - from workers/tokens/sync.ts's own
// CoinGecko-driven discovery, or a previous call to this same function -
// must never have a real, already-known coingeckoId clobbered back to
// "unknown" just because this call happens to run later. Only a genuinely
// NEW row gets coingeckoId: null (honest - not fabricated, not guessed).
export async function ensureOnChainTokenRow(chainId: string, address: string, symbol: string | null, decimals: number): Promise<string> {
  const normalizedAddress = address.toLowerCase();
  const resolvedSymbol = symbol ?? normalizedAddress.slice(0, 10); // same "no real symbol -> short address prefix" fallback register.ts's own pools.label construction already established

  const [row] = await db
    .insert(tokens)
    .values({ chainId, address: normalizedAddress, symbol: resolvedSymbol, decimals })
    .onConflictDoUpdate({
      target: [tokens.chainId, tokens.address],
      set: { symbol: resolvedSymbol, decimals },
    })
    .returning({ id: tokens.id });

  return row.id;
}
