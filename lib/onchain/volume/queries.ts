import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, pools, swapEvents } from "@/lib/database/schema";

export async function getChainId(chainSlug: string): Promise<string | null> {
  const [row] = await db.select({ id: chains.id }).from(chains).where(eq(chains.slug, chainSlug));
  return row?.id ?? null;
}

// Reads the pool row by its config key without upserting - mirrors
// getReferenceAssetTokenId's own read-only-lookup shape
// (lib/onchain/pricing/tokens.ts). Deliberately does NOT sync/create the
// row itself: `pools` is kept in sync with VERIFIED_POOLS by
// syncPoolsFromConfig (lib/onchain/pools.ts), already run on every TVL
// verification cycle (workers/onchain/verify.ts) - this engine reuses that
// existing canonical row rather than maintaining a second, competing sync
// path for the exact same pool identity. A pool not yet synced (verify.ts
// has never run) returns null here, and engine.ts skips that pool for the
// run with a clear, logged reason rather than inventing a row.
export async function getPoolIdByConfigKey(configKey: string): Promise<string | null> {
  const [row] = await db.select({ id: pools.id }).from(pools).where(eq(pools.configKey, configKey));
  return row?.id ?? null;
}

export interface LatestVolumeObservation {
  value: string;
  timestamp: Date;
  blockNumber: string | null;
}

// The latest still-canonical (reorgInvalidatedAt IS NULL) aggregate
// observation for one pool/metric - used by engine.ts to feed
// checkVolumeSpike (quality.ts) a real "previous run" baseline. Same
// historical_observations_entity_idx index every other "latest observation
// for this entity" query in this app already relies on (see
// getNativeTokenPrice, lib/onchain/pricing/queries.ts, for the direct
// precedent this mirrors).
export async function getLatestVolumeObservation(
  poolId: string,
  metric: "volume_usd" | "fees_usd" | "revenue_usd",
): Promise<LatestVolumeObservation | null> {
  const [row] = await db
    .select({ value: historicalObservations.value, timestamp: historicalObservations.timestamp, blockNumber: historicalObservations.blockNumber })
    .from(historicalObservations)
    .where(
      and(
        eq(historicalObservations.entityType, "pool"),
        eq(historicalObservations.entityId, poolId),
        eq(historicalObservations.metric, metric),
        isNull(historicalObservations.reorgInvalidatedAt),
      ),
    )
    .orderBy(desc(historicalObservations.timestamp))
    .limit(1);

  return row ?? null;
}

export interface DailyVolumePoint {
  day: Date;
  volumeUsd: string;
}

// Section 13's "daily/weekly/monthly ... computed FROM DeFiHub's own
// observations, never via repeated external API calls": sums this pool's
// own already-computed, already-priced volume_usd observations
// (historicalObservations rows this engine itself wrote, one per indexing
// run) into calendar-day buckets - never re-reads swap_events or
// re-prices anything. A caller wanting weekly/monthly can bucket these
// daily points further in memory, or a future change can add its own
// date_trunc('week'/'month', ...) variant using the exact same pattern.
// Same UTC-pinned date_trunc discipline as getGlobalTvlHistory
// (lib/database/queries/chains.ts) - see that function's own comment for
// why the double `AT TIME ZONE 'UTC'` is required, not decorative.
// Reorged runs (reorgInvalidatedAt set) are excluded, matching every other
// canonical-history read in this app.
export async function getDailyVolumeHistory(
  poolId: string,
  metric: "volume_usd" | "fees_usd" = "volume_usd",
): Promise<DailyVolumePoint[]> {
  const dayTrunc = sql`(date_trunc('day', ${historicalObservations.timestamp} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  const rows = await db
    .select({
      day: sql<Date>`${dayTrunc}`.as("day"),
      volumeUsd: sql<string>`sum(${historicalObservations.value})`.as("volume_usd"),
    })
    .from(historicalObservations)
    .where(
      and(
        eq(historicalObservations.entityType, "pool"),
        eq(historicalObservations.entityId, poolId),
        eq(historicalObservations.metric, metric),
        isNull(historicalObservations.reorgInvalidatedAt),
      ),
    )
    .groupBy(dayTrunc)
    .orderBy(dayTrunc);

  // Same driver-string-not-Date coercion getGlobalTvlHistory's own comment
  // documents for date_trunc results.
  return rows.map((r) => ({ day: new Date(r.day as unknown as string), volumeUsd: r.volumeUsd }));
}

export interface SwapEventSummary {
  transactionHash: string;
  logIndex: number;
  blockNumber: string;
  blockTimestamp: Date;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
}

// Bounded raw-event read for provenance drill-down (Section 7's "a
// historical volume number must be explainable") - never called without a
// limit, this table is expected to grow without bound the same way
// chain_metrics/protocol_metrics/token_prices already do.
export async function getRecentSwapEvents(poolId: string, limit: number): Promise<SwapEventSummary[]> {
  const rows = await db
    .select({
      transactionHash: swapEvents.transactionHash,
      logIndex: swapEvents.logIndex,
      blockNumber: swapEvents.blockNumber,
      blockTimestamp: swapEvents.blockTimestamp,
      amount0In: swapEvents.amount0In,
      amount1In: swapEvents.amount1In,
      amount0Out: swapEvents.amount0Out,
      amount1Out: swapEvents.amount1Out,
    })
    .from(swapEvents)
    .where(and(eq(swapEvents.poolId, poolId), isNull(swapEvents.reorgInvalidatedAt)))
    .orderBy(desc(swapEvents.blockNumber), desc(swapEvents.logIndex))
    .limit(limit);

  return rows;
}

export interface SwapEventRecheckCandidate {
  id: string;
  blockNumber: bigint;
  blockHash: string;
}

// The swap_events twin of getObservationsNeedingRecheck
// (lib/database/queries/onchain-recheck.ts) - same "bound by distinct
// block numbers, then take every row for the selected numbers with no
// further limit" discipline, for the same reason: multiple swaps commonly
// share one block, and a row-level LIMIT could split that block's sibling
// events across a batch boundary, permanently stranding whichever ones
// landed outside it once the cursor advances past that block number.
export async function getSwapEventsNeedingRecheck(
  poolId: string,
  afterBlockNumber: bigint | null,
  limit: number,
): Promise<SwapEventRecheckCandidate[]> {
  const baseConditions = [eq(swapEvents.poolId, poolId), isNull(swapEvents.reorgInvalidatedAt)];
  const conditions = afterBlockNumber != null ? [...baseConditions, gt(swapEvents.blockNumber, afterBlockNumber.toString())] : baseConditions;

  const blockNumberRows = await db
    .selectDistinct({ blockNumber: swapEvents.blockNumber })
    .from(swapEvents)
    .where(and(...conditions))
    .orderBy(afterBlockNumber != null ? asc(swapEvents.blockNumber) : desc(swapEvents.blockNumber))
    .limit(limit);

  const blockNumbers = blockNumberRows.map((r) => r.blockNumber);
  if (blockNumbers.length === 0) return [];

  const rows = await db
    .select({ id: swapEvents.id, blockNumber: swapEvents.blockNumber, blockHash: swapEvents.blockHash })
    .from(swapEvents)
    .where(and(...baseConditions, inArray(swapEvents.blockNumber, blockNumbers)))
    .orderBy(asc(swapEvents.blockNumber), asc(swapEvents.id));

  return rows.map((r) => ({ id: r.id, blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash }));
}

// Bulk version of markObservationReorged (onchain-recheck.ts) for
// swap_events - one UPDATE ... WHERE id = ANY(...) per resolved block-number
// group, not one per row (Section 28's "avoid one DB write per event"
// applies just as much to this recheck path as it does to the original
// indexing write path).
export async function markSwapEventsReorged(ids: string[], invalidatedAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(swapEvents).set({ reorgInvalidatedAt: invalidatedAt }).where(inArray(swapEvents.id, ids));
}
