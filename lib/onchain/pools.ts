import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, poolTokens, pools, protocols } from "@/lib/database/schema";
import { VERIFIED_POOLS, type VerifiedPool } from "./config";

// Keeps the `pools`/`pool_tokens` tables in sync with VERIFIED_POOLS - the
// human-curated config (lib/onchain/config.ts) stays the source of truth an
// engineer edits and reviews; this makes those same entries queryable as
// real canonical rows too, upserted by configKey. Never auto-discovers a
// pool the config doesn't already list - if a config entry's chain isn't
// tracked yet, that entry is simply left unsynced rather than erroring,
// since verifyAllPools already skips it the same way for the same reason.
//
// `poolsToSync` defaults to the real config and is only ever overridden by
// tests - it exists so the transactional per-pool sync below (and its
// failure-path behavior) can be exercised against synthetic data without
// touching the real VERIFIED_POOLS entries.
export async function syncPoolsFromConfig(poolsToSync: VerifiedPool[] = VERIFIED_POOLS): Promise<Map<string, string>> {
  const poolIdByConfigKey = new Map<string, string>();
  if (poolsToSync.length === 0) return poolIdByConfigKey;

  const [chainRows, protocolRows] = await Promise.all([
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
  ]);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));

  for (const pool of poolsToSync) {
    const chainId = chainIdBySlug.get(pool.chainSlug);
    if (!chainId) continue;
    const protocolId = protocolIdBySlug.get(pool.protocolDefillamaSlug) ?? null;

    // The upsert, token delete, and token reinsert must all commit or all
    // roll back together - without a transaction, a failure partway
    // through (e.g. the reinsert violating a constraint) would leave a
    // pool row pointing at zero tokens instead of its previous, still-
    // correct set. `poolId` is only recorded into the returned map once
    // this whole block has actually committed, so a caller never sees a
    // key for a pool whose sync didn't fully succeed.
    const poolId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(pools)
        .values({ configKey: pool.key, chainId, protocolId, label: pool.label, address: pool.poolAddress })
        .onConflictDoUpdate({
          target: pools.configKey,
          set: { chainId, protocolId, label: pool.label, address: pool.poolAddress, updatedAt: new Date() },
        })
        .returning({ id: pools.id });

      // Pool tokens are fully replaced (delete + reinsert) rather than
      // diffed on each sync - the config's token list for a given pool
      // effectively never changes after it's added (a pool's own held
      // tokens don't change), so this keeps the sync idempotent and simple
      // instead of needing per-token upsert-by-position reconciliation for
      // a case that doesn't arise in practice.
      await tx.delete(poolTokens).where(eq(poolTokens.poolId, row.id));
      if (pool.tokens.length > 0) {
        await tx.insert(poolTokens).values(
          pool.tokens.map((t, i) => ({
            poolId: row.id,
            address: t.address,
            symbol: t.symbol,
            decimals: t.decimals,
            coingeckoId: t.coingeckoId,
            position: i,
          })),
        );
      }

      return row.id;
    });

    poolIdByConfigKey.set(pool.key, poolId);
  }

  return poolIdByConfigKey;
}
