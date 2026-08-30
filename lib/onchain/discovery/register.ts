import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
// configKey still needs SOME value (the column is NOT NULL UNIQUE, and
// GLOBAL - not scoped per chain) - a deterministic
// `discovered:<chain discriminator>:<lowercased address>` string. The
// discriminator is load-bearing, not decorative: `pools.configKey` has no
// per-chain scoping of its own, so two DIFFERENT real pools on two
// DIFFERENT chains that happen to share the exact same 20-byte address
// (a genuine possibility for CREATE2-deployed contracts, which many real
// deployment frameworks intentionally replicate at identical addresses
// across chains) would otherwise collide on this one GLOBAL unique column
// even though `pools_chain_address_unique` (chainId, address) correctly
// treats them as two distinct rows - an unhandled Postgres unique-
// violation on the SECOND chain's registration, not a clean upsert.
//
// The discriminator is a short HASH of chainSlug, not the raw slug itself.
// chains.slug (lib/database/schema.ts) is itself a varchar(64) - embedding
// it verbatim would leave only ~10 spare characters of the config_key
// column's own varchar(64) budget once "discovered:" (11), two ":"
// separators, and a fixed 42-char "0x"+40-hex address are accounted for,
// which even today's real slugs ("bnb-chain", "avalanche" at 9 chars)
// barely clear - any future chain onboarded with a moderately descriptive
// slug (e.g. "polygon-zkevm") would immediately break discovery for it.
// Hashing bounds the discriminator to a fixed length regardless of
// chainSlug length, so this format tolerates any slug the schema itself
// permits. 8 hex chars (32 bits) makes a collision between two of this
// app's small, developer-curated set of chains astronomically unlikely -
// and even in that combined-with-a-real-address-collision scenario, the
// config_key UNIQUE constraint turns it into a loud insert failure, never
// silent corruption.
const CONFIG_KEY_MAX_LENGTH = 64;
const CHAIN_DISCRIMINATOR_HEX_LENGTH = 8;

function chainDiscriminator(chainSlug: string): string {
  return createHash("sha256").update(chainSlug).digest("hex").slice(0, CHAIN_DISCRIMINATOR_HEX_LENGTH);
}

export function discoveredPoolConfigKey(chainSlug: string, poolAddress: string): string {
  const key = `discovered:${chainDiscriminator(chainSlug)}:${poolAddress.toLowerCase()}`;
  if (key.length > CONFIG_KEY_MAX_LENGTH) {
    // Unreachable for any well-formed EVM address (a fixed 42 chars) given
    // the discriminator's own fixed length above - kept as a defensive
    // fail-loud guard against a malformed poolAddress slipping through,
    // never silently truncated.
    throw new Error(
      `discoveredPoolConfigKey: "${key}" is ${key.length} characters, exceeding pools.config_key's varchar(${CONFIG_KEY_MAX_LENGTH}) column limit - poolAddress "${poolAddress}" is longer than a standard 20-byte EVM address, never truncate here (truncating would silently reintroduce the exact cross-entity collision risk this discriminator exists to prevent)`,
    );
  }
  return key;
}

export interface DiscoveredPoolTokenMetadata {
  address: string;
  symbol: string | null;
  decimals: number;
}

// A pool already tracked under a HAND-CURATED config entry (VERIFIED_POOLS/
// VOLUME_SOURCE_POOLS, synced via syncPoolsFromConfig) must never be
// silently overwritten by discovery finding the exact same on-chain
// address. Recognized purely by configKey convention: every discovery-
// owned `pools` row's configKey starts with "discovered:" (this function's
// own output, above) - a curated row's configKey is always the raw,
// hand-typed VerifiedPool.key from lib/onchain/config.ts, which never uses
// that prefix. If discovery ever encounters a pool address that already
// has a curated row, this returns that row's id UNCHANGED and leaves its
// label/protocolId/pool_tokens (including any real coingeckoId a curated
// pool's tokens carry, used for CoinGecko fallback pricing elsewhere in
// this app) completely untouched - discovery recognizes "already tracked,"
// it does not compete with or clobber the human-verified version.
function isDiscoveryOwnedConfigKey(configKey: string): boolean {
  return configKey.startsWith("discovered:");
}

export async function registerDiscoveredPoolAsPool(
  chainId: string,
  protocolId: string | null,
  deployment: FactoryDeployment,
  poolAddress: string,
  token0: DiscoveredPoolTokenMetadata,
  token1: DiscoveredPoolTokenMetadata,
): Promise<string> {
  // Lowercased here too (defense in depth alongside queries.ts's own
  // persistence-boundary normalization) - registerDiscoveredPoolAsPool is
  // a public function or another caller could reach it without having gone
  // through recordDiscoveredPools first, and this function's own
  // (chainId, address) collision check below only works if the address is
  // normalized the exact same way every other row in `pools` already is.
  const normalizedAddress = poolAddress.toLowerCase();
  const normalizedToken0 = { ...token0, address: token0.address.toLowerCase() };
  const normalizedToken1 = { ...token1, address: token1.address.toLowerCase() };
  const configKey = discoveredPoolConfigKey(deployment.chainSlug, normalizedAddress);
  const label = `${normalizedToken0.symbol ?? normalizedToken0.address.slice(0, 8)}/${normalizedToken1.symbol ?? normalizedToken1.address.slice(0, 8)} (discovered, ${deployment.key})`;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: pools.id, configKey: pools.configKey })
      .from(pools)
      .where(and(eq(pools.chainId, chainId), eq(pools.address, normalizedAddress)));

    if (existing && !isDiscoveryOwnedConfigKey(existing.configKey)) {
      return existing.id;
    }

    const [row] = await tx
      .insert(pools)
      .values({ configKey, chainId, protocolId, label, address: normalizedAddress })
      .onConflictDoUpdate({
        target: [pools.chainId, pools.address],
        set: { protocolId, label, updatedAt: new Date() },
      })
      .returning({ id: pools.id });

    if (!row) {
      throw new Error(`registerDiscoveredPoolAsPool: upsert for pool ${normalizedAddress} on chain ${chainId} returned no row - insert/update may have been silently skipped`);
    }

    // Same "fully replace, never diff" discipline as syncPoolsFromConfig -
    // a discovered pool's own token0/token1 never change after creation
    // (a V2 pair's tokens are immutable), so this stays idempotent and
    // simple rather than needing per-token upsert-by-position
    // reconciliation for a case that cannot arise in practice. Only ever
    // reached for a NEW row or an EXISTING discovery-owned one (the
    // curated-pool branch above already returned) - a curated pool's own
    // token rows are never deleted here.
    await tx.delete(poolTokens).where(eq(poolTokens.poolId, row.id));
    await tx.insert(poolTokens).values([
      { poolId: row.id, address: normalizedToken0.address, symbol: normalizedToken0.symbol ?? "UNKNOWN", decimals: normalizedToken0.decimals, coingeckoId: null, position: 0 },
      { poolId: row.id, address: normalizedToken1.address, symbol: normalizedToken1.symbol ?? "UNKNOWN", decimals: normalizedToken1.decimals, coingeckoId: null, position: 1 },
    ]);

    return row.id;
  });
}
