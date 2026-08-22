import { and, count, eq, gte } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, onchainVerifications, pools, protocols } from "@/lib/database/schema";

// Phase 4's "DeFiHub internal data interface" for pool TVL - see
// docs/native-data.md for why this is scoped to pools specifically rather
// than a protocol-wide native/external toggle: a verified pool's TVL is a
// complete, authoritative figure for that one pool, but it's a narrow
// subset of a protocol's real total TVL (which spans many more pools than
// this app verifies) - presenting "sum of verified pools" as if it were
// "the protocol's native TVL, falling back to DefiLlama when unavailable"
// would materially understate reality and mislabel a partial figure as a
// complete one. The honest version of this interface operates at the
// granularity where DeFiHub's own calculation genuinely *is* the complete
// answer: one specific pool.

export interface VerifiedPoolListItem {
  id: string;
  configKey: string;
  label: string;
  address: string;
  chainSlug: string;
  chainName: string;
  chainLogoUrl: string | null;
  protocolSlug: string | null;
  protocolName: string | null;
  // Null when this pool has been synced from config but not yet verified
  // by a live RPC read (e.g. the very first run after being added) -
  // never fabricated as 0 or omitted silently.
  latestTvlUsd: number | null;
  latestBlockNumber: number | null;
  latestVerifiedAt: Date | null;
}

export async function getVerifiedPools(): Promise<VerifiedPoolListItem[]> {
  const rows = await db
    .select({
      id: pools.id,
      configKey: pools.configKey,
      label: pools.label,
      address: pools.address,
      chainSlug: chains.slug,
      chainName: chains.name,
      chainLogoUrl: chains.logoUrl,
      protocolSlug: protocols.slug,
      protocolName: protocols.name,
      latestTvlUsd: onchainVerifications.tvlUsd,
      latestBlockNumber: onchainVerifications.blockNumber,
      latestVerifiedAt: onchainVerifications.verifiedAt,
    })
    .from(pools)
    .innerJoin(chains, eq(chains.id, pools.chainId))
    .leftJoin(protocols, eq(protocols.id, pools.protocolId))
    // Left, not inner - a pool synced from config but not yet verified by
    // any RPC read still has a real row here with a null TVL, rather than
    // silently disappearing from the list.
    .leftJoin(onchainVerifications, eq(onchainVerifications.key, pools.configKey));

  return rows.map((r) => ({
    ...r,
    latestTvlUsd: r.latestTvlUsd != null ? Number(r.latestTvlUsd) : null,
    latestBlockNumber: r.latestBlockNumber != null ? Number(r.latestBlockNumber) : null,
  }));
}

export interface PoolTvlObservation {
  timestamp: Date;
  value: number;
  blockNumber: number | null;
  source: string;
  calculationVersion: string | null;
}

// Server-side date-range pushdown, same convention as every other history
// query in this codebase (getChainHistory, getProtocolHistory, ...) -
// `since: null` means no lower bound. Never loads the unbounded full
// history of every observation ever recorded.
export async function getPoolTvlHistory(poolId: string, since: Date | null): Promise<PoolTvlObservation[]> {
  const conditions = [
    eq(historicalObservations.entityType, "pool"),
    eq(historicalObservations.entityId, poolId),
    eq(historicalObservations.metric, "tvl_usd"),
  ];
  if (since) conditions.push(gte(historicalObservations.timestamp, since));

  const rows = await db
    .select({
      timestamp: historicalObservations.timestamp,
      value: historicalObservations.value,
      blockNumber: historicalObservations.blockNumber,
      source: historicalObservations.source,
      calculationVersion: historicalObservations.calculationVersion,
    })
    .from(historicalObservations)
    .where(and(...conditions))
    .orderBy(historicalObservations.timestamp);

  return rows.map((r) => ({
    timestamp: r.timestamp,
    value: Number(r.value),
    blockNumber: r.blockNumber != null ? Number(r.blockNumber) : null,
    source: r.source,
    calculationVersion: r.calculationVersion,
  }));
}

// How many native TVL observations exist for a pool - a cheap way for the
// UI to show "N observations tracked since <date>" (proving real history
// accumulates over time) without pulling every row just to count them.
export async function getPoolObservationCount(poolId: string): Promise<{ count: number; earliestAt: Date | null }> {
  const conditions = and(
    eq(historicalObservations.entityType, "pool"),
    eq(historicalObservations.entityId, poolId),
    eq(historicalObservations.metric, "tvl_usd"),
  );

  const [countRow, earliestRow] = await Promise.all([
    db.select({ value: count() }).from(historicalObservations).where(conditions),
    db
      .select({ timestamp: historicalObservations.timestamp })
      .from(historicalObservations)
      .where(conditions)
      .orderBy(historicalObservations.timestamp)
      .limit(1),
  ]);

  return { count: countRow[0]?.value ?? 0, earliestAt: earliestRow[0]?.timestamp ?? null };
}
