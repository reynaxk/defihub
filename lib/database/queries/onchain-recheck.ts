import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, pools } from "@/lib/database/schema";

// Query support for workers/onchain/recheck-reorgs.ts. Deliberately scoped
// to `pools`/`historical_observations` only - those are the only tables
// that carry real block-hash provenance today. `onchain_verifications` (the
// table VERIFIED_PROTOCOL_TVLS' 2 entries write to) has no blockHash column
// at all, so there is nothing here for a protocol-TVL entry to be
// rechecked against - see recheck-reorgs.ts's own module comment for why
// that's a reported gap, not something this file works around.

export interface RecheckPoolEntity {
  poolId: string;
  configKey: string;
  chainSlug: string;
}

// `pools` is kept in exact sync with VERIFIED_POOLS by syncPoolsFromConfig
// (lib/onchain/pools.ts) on every verification run, and is never populated
// any other way (see that table's own schema.ts comment) - so selecting
// every row here already *is* "the verified pools," with no need to
// reference VERIFIED_POOLS directly or filter further.
export async function getVerifiedPoolEntities(): Promise<RecheckPoolEntity[]> {
  return await db
    .select({ poolId: pools.id, configKey: pools.configKey, chainSlug: chains.slug })
    .from(pools)
    .innerJoin(chains, eq(chains.id, pools.chainId))
    .orderBy(pools.configKey);
}

export interface RecheckCandidate {
  id: string;
  blockNumber: bigint;
  blockHash: string;
}

// The observations for one pool that still need a reorg recheck this run -
// bounded by `limit` on both branches (see recheck-reorgs.ts's own
// lookbackDepth), so neither a long-paused job nor a pool with months of
// history can turn one run into an unbounded amount of RPC work.
//
// `afterBlockNumber == null` means this pool has no recheck cursor yet
// (recheck-reorgs.ts's first-ever run for it) - takes the `limit` most
// *recent* observations (DESC + LIMIT, re-sorted ascending for the caller,
// same shape as getPoolTvlHistory) rather than the oldest ones on record,
// so a cold start checks what's actually current instead of replaying
// months-old, long-since-buried history. Once a cursor exists,
// `afterBlockNumber` bounds the query directly and results are already in
// blockNumber order with no re-sort needed.
//
// blockHash IS NOT NULL is a real filter, not a formality:
// recordPoolVerification only ever writes a blockHash-less observation when
// the hash it read was missing/malformed (see its own comment), and a row
// with no hash has nothing this job could compare against the chain.
export async function getObservationsNeedingRecheck(
  poolId: string,
  afterBlockNumber: bigint | null,
  limit: number,
): Promise<RecheckCandidate[]> {
  // Both columns are nullable at the type level (a pre-blockHash-provenance
  // legacy row - see historicalObservations' own schema comment - could in
  // principle have a null blockNumber too), even though the
  // historical_observations_pool_tvl_requires_block_identity CHECK
  // constraint already guarantees both are set together for every
  // entityType='pool'/metric='tvl_usd' row going forward. Filtering on both
  // explicitly, rather than trusting the constraint implicitly, keeps this
  // query correct on its own terms and keeps toRecheckCandidate below able
  // to convert without a non-null assertion.
  const baseConditions = [
    eq(historicalObservations.entityType, "pool"),
    eq(historicalObservations.entityId, poolId),
    eq(historicalObservations.metric, "tvl_usd"),
    isNotNull(historicalObservations.blockNumber),
    isNotNull(historicalObservations.blockHash),
  ];

  if (afterBlockNumber != null) {
    const rows = await db
      .select({
        id: historicalObservations.id,
        blockNumber: historicalObservations.blockNumber,
        blockHash: historicalObservations.blockHash,
      })
      .from(historicalObservations)
      .where(and(...baseConditions, gt(historicalObservations.blockNumber, afterBlockNumber.toString())))
      .orderBy(asc(historicalObservations.blockNumber))
      .limit(limit);

    return rows.flatMap(toRecheckCandidate);
  }

  const recent = db
    .select({
      id: historicalObservations.id,
      blockNumber: historicalObservations.blockNumber,
      blockHash: historicalObservations.blockHash,
    })
    .from(historicalObservations)
    .where(and(...baseConditions))
    .orderBy(desc(historicalObservations.blockNumber))
    .limit(limit)
    .as("recent");

  const rows = await db.select().from(recent).orderBy(asc(recent.blockNumber));
  return rows.flatMap(toRecheckCandidate);
}

// The isNotNull filters above already guarantee both fields are non-null in
// practice - flatMap (returning [] for the impossible case rather than a
// non-null assertion) keeps that a runtime-safe guarantee instead of an
// assumption the type checker just has to trust.
function toRecheckCandidate(row: { id: string; blockNumber: string | null; blockHash: string | null }): RecheckCandidate[] {
  if (row.blockNumber == null || row.blockHash == null) return [];
  return [{ id: row.id, blockNumber: BigInt(row.blockNumber), blockHash: row.blockHash }];
}
