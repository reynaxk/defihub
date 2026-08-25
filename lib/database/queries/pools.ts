import { and, asc, count, desc, eq, gte, isNull, min } from "drizzle-orm";
import { db } from "@/lib/database/client";
import {
  chains,
  historicalObservations,
  onchainVerifications,
  pools,
  protocols,
  type HistoricalObservationCalculationInput,
} from "@/lib/database/schema";

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
  // The exact decimal string historical_observations.value actually
  // stores (numeric(32,8), returned by drizzle/postgres.js as a string,
  // never auto-parsed to a number) - never wrapped in Number() here,
  // which would silently corrupt any value beyond Number.MAX_SAFE_INTEGER
  // that also has a fractional component. A caller that only needs a
  // display-bounded number converts explicitly at its own call site.
  value: string;
  blockNumber: number | null;
  // All four null for any observation recorded before this provenance was
  // captured (or whose source never had it) - never backfilled or guessed.
  blockHash: string | null;
  priceSource: string | null;
  priceRetrievedAt: Date | null;
  calculationInputs: HistoricalObservationCalculationInput[] | null;
  source: string;
  calculationVersion: string | null;
}

// A row cap on every call, not just an opt-in default a caller has to
// remember to pass. Unlike chain_metrics/protocol_metrics/token_prices,
// historical_observations has no retention/rollup worker downsampling it
// over time (see workers/retention/rollup.ts's own scope - it doesn't
// touch this table), so `since: null` (the "give me everything" case) has
// nothing else keeping it from growing genuinely unbounded as verification
// runs accumulate every 30 minutes (vercel.json's cron), forever. ~100+
// days of coverage at that cadence - comfortably past the app's existing
// 90-day convention, while staying a small, fixed-size response either way.
const DEFAULT_POOL_TVL_HISTORY_LIMIT = 5000;
// The floor a caller-supplied `limit` gets corrected to when it's zero,
// negative, or otherwise nonsensical - never 0 (a query that always
// returns nothing isn't a "safe" substitute for an invalid input) and
// never silently passed through.
const MIN_POOL_TVL_HISTORY_LIMIT = 1;

// Clamps an arbitrary caller-supplied `limit` into a value that's always
// safe to hand to Postgres's LIMIT clause - the default parameter above
// only covers an *omitted* argument, not one a caller builds from
// unchecked input (e.g. a query-string parameter parsed with `Number(...)`,
// which can produce NaN, Infinity, a negative number, or a fraction).
// DEFAULT_POOL_TVL_HISTORY_LIMIT doubles as the upper bound: there is no
// way to request more than that many rows, regardless of what's passed in.
export function normalizePoolTvlHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_POOL_TVL_HISTORY_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated < MIN_POOL_TVL_HISTORY_LIMIT) return MIN_POOL_TVL_HISTORY_LIMIT;
  return Math.min(truncated, DEFAULT_POOL_TVL_HISTORY_LIMIT);
}

// Server-side date-range pushdown, same convention as every other history
// query in this codebase (getChainHistory, getProtocolHistory, ...) -
// `since: null` means no lower bound. `limit` is always applied (default
// DEFAULT_POOL_TVL_HISTORY_LIMIT above) and always normalized (see
// normalizePoolTvlHistoryLimit) before it ever reaches the database -
// there's no way to request a genuinely unbounded result, or an invalid
// one. When more rows exist than `limit` allows, the *most recent* ones
// are kept (the useful window for "how has this pool trended lately"),
// not simply the first `limit` in chronological order - the cutoff is
// applied as an ORDER BY DESC + LIMIT subquery, in the database, then
// re-sorted ascending for the outer query so callers see the same
// chronological order this function has always returned, never by loading
// every row and slicing in JavaScript.
export async function getPoolTvlHistory(
  poolId: string,
  since: Date | null,
  limit: number = DEFAULT_POOL_TVL_HISTORY_LIMIT,
): Promise<PoolTvlObservation[]> {
  const normalizedLimit = normalizePoolTvlHistoryLimit(limit);

  const conditions = [
    eq(historicalObservations.entityType, "pool"),
    eq(historicalObservations.entityId, poolId),
    eq(historicalObservations.metric, "tvl_usd"),
    // Excludes any observation workers/onchain/recheck-reorgs.ts has since
    // determined was reorged off the canonical chain (reorgInvalidatedAt
    // set - see that column's own schema.ts comment). The row itself is
    // never deleted, only excluded from this canonical-history result -
    // provenance stays queryable directly for debugging/audit.
    isNull(historicalObservations.reorgInvalidatedAt),
  ];
  if (since) conditions.push(gte(historicalObservations.timestamp, since));

  const recent = db
    .select({
      timestamp: historicalObservations.timestamp,
      value: historicalObservations.value,
      blockNumber: historicalObservations.blockNumber,
      blockHash: historicalObservations.blockHash,
      priceSource: historicalObservations.priceSource,
      priceRetrievedAt: historicalObservations.priceRetrievedAt,
      calculationInputs: historicalObservations.calculationInputs,
      source: historicalObservations.source,
      calculationVersion: historicalObservations.calculationVersion,
    })
    .from(historicalObservations)
    .where(and(...conditions))
    .orderBy(desc(historicalObservations.timestamp))
    .limit(normalizedLimit)
    .as("recent");

  const rows = await db.select().from(recent).orderBy(asc(recent.timestamp));

  return rows.map((r) => ({
    timestamp: r.timestamp,
    value: r.value,
    blockNumber: r.blockNumber != null ? Number(r.blockNumber) : null,
    blockHash: r.blockHash,
    priceSource: r.priceSource,
    priceRetrievedAt: r.priceRetrievedAt,
    calculationInputs: r.calculationInputs,
    source: r.source,
    calculationVersion: r.calculationVersion,
  }));
}

// How many native TVL observations exist for a pool - a cheap way for the
// UI to show "N observations tracked since <date>" (proving real history
// accumulates over time) without pulling every row just to count them.
export async function getPoolObservationCount(poolId: string): Promise<{ count: number; earliestAt: Date | null }> {
  // A single aggregate query, not a count() and a separate ORDER BY/LIMIT 1
  // query - COUNT and MIN over the same WHERE clause happen in one pass,
  // and an aggregate query with no GROUP BY always returns exactly one row
  // (count: 0, earliest: null for zero matches), never zero rows, so this
  // stays correct for a pool with no observations without special-casing it.
  const [row] = await db
    .select({ count: count(), earliest: min(historicalObservations.timestamp) })
    .from(historicalObservations)
    .where(
      and(
        eq(historicalObservations.entityType, "pool"),
        eq(historicalObservations.entityId, poolId),
        eq(historicalObservations.metric, "tvl_usd"),
        isNull(historicalObservations.reorgInvalidatedAt),
      ),
    );

  return { count: row?.count ?? 0, earliestAt: row?.earliest ?? null };
}
