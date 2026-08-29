import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { pools, poolTokens } from "@/lib/database/schema";
import type { FactoryDeployment } from "./config";

// Bridges one validated discovered pool into the SAME `pools`/`pool_tokens`
// tables config-curated pools already use - the exact "smallest safe
// bridge" Section 11 asks for, not a parallel identity the indexing engine
// needs to know anything new about. Mirrors syncPoolsFromConfig's
// (lib/onchain/pools.ts) own transactional upsert-then-replace-tokens
// shape byte-for-byte - same atomicity reasoning (a failure partway
// through must never leave a pool row pointing at zero/wrong tokens), just
// upserting on pools_chain_address_unique (chainId, address) instead of
// configKey, since a discovered pool's natural identity is its own chain
// address, not a hand-typed config key.
//
// configKey still needs SOME value (the column is NOT NULL UNIQUE) - a
// deterministic `discovered:<lowercased address>` string, safely under the
// 64-char column limit for any real chain slug + address combination.
// Never used for lookups by this module (poolAddress/chainId is the real
// identity here); kept legible purely so a person reading the `pools`
// table can immediately tell a discovery-sourced row apart from a
// hand-curated VERIFIED_POOLS one without cross-referencing
// discovered_pools.
export function discoveredPoolConfigKey(poolAddress: string): string {
  return `discovered:${poolAddress.toLowerCase()}`;
}

export interface DiscoveredPoolTokenMetadata {
  address: string;
  symbol: string | null;
  decimals: number;
}

export async function registerDiscoveredPoolAsPool(
  chainId: string,
  protocolId: string | null,
  deployment: FactoryDeployment,
  poolAddress: string,
  token0: DiscoveredPoolTokenMetadata,
  token1: DiscoveredPoolTokenMetadata,
): Promise<string> {
  const configKey = discoveredPoolConfigKey(poolAddress);
  const label = `${token0.symbol ?? token0.address.slice(0, 8)}/${token1.symbol ?? token1.address.slice(0, 8)} (discovered, ${deployment.key})`;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(pools)
      .values({ configKey, chainId, protocolId, label, address: poolAddress })
      .onConflictDoUpdate({
        target: [pools.chainId, pools.address],
        set: { protocolId, label, updatedAt: new Date() },
      })
      .returning({ id: pools.id });

    // Same "fully replace, never diff" discipline as syncPoolsFromConfig -
    // a discovered pool's own token0/token1 never change after creation
    // (a V2 pair's tokens are immutable), so this stays idempotent and
    // simple rather than needing per-token upsert-by-position
    // reconciliation for a case that cannot arise in practice.
    await tx.delete(poolTokens).where(eq(poolTokens.poolId, row.id));
    await tx.insert(poolTokens).values([
      { poolId: row.id, address: token0.address, symbol: token0.symbol ?? "UNKNOWN", decimals: token0.decimals, coingeckoId: null, position: 0 },
      { poolId: row.id, address: token1.address, symbol: token1.symbol ?? "UNKNOWN", decimals: token1.decimals, coingeckoId: null, position: 1 },
    ]);

    return row.id;
  });
}
