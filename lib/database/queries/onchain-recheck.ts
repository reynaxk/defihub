import { and, asc, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
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
// bounded by `limit` *distinct block numbers* (see below for why rows
// aren't the right unit to bound), so neither a long-paused job nor a pool
// with months of history can turn one run into an unbounded amount of RPC
// work.
//
// `afterBlockNumber == null` means this pool has no recheck cursor yet
// (recheck-reorgs.ts's first-ever run for it) - takes the `limit` most
// *recent* block numbers rather than the oldest ones on record, so a cold
// start checks what's actually current instead of replaying months-old,
// long-since-buried history. Once a cursor exists, `afterBlockNumber`
// bounds the query directly.
//
// blockHash IS NOT NULL is a real filter, not a formality:
// recordPoolVerification only ever writes a blockHash-less observation when
// the hash it read was missing/malformed (see its own comment), and a row
// with no hash has nothing this job could compare against the chain.
//
// `limit` bounds distinct block numbers, not raw rows: the reorg-aware
// identity model this app uses deliberately allows two observations for
// the same pool to share a blockNumber with different blockHash values
// (see this file's own module comment - that's exactly what "same block
// number, different chain history" means). A row-level LIMIT could cut a
// shared block number's sibling rows in half; whichever sibling landed
// outside that batch would then be permanently skipped once
// recheck-reorgs.ts advanced its cursor past that block number, since a
// `blockNumber > cursor` comparison never revisits it. Selecting whole
// block numbers first, then every row for the selected numbers with no
// further row limit, guarantees a block number's entire sibling set always
// arrives together - the caller can then safely advance its cursor to any
// block number that appears in the result at all, never leaving an
// unfetched sibling behind it.
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
  const conditions =
    afterBlockNumber != null
      ? [...baseConditions, gt(historicalObservations.blockNumber, afterBlockNumber.toString())]
      : baseConditions;

  const blockNumberRows = await db
    .selectDistinct({ blockNumber: historicalObservations.blockNumber })
    .from(historicalObservations)
    .where(and(...conditions))
    .orderBy(
      afterBlockNumber != null
        ? asc(historicalObservations.blockNumber)
        : desc(historicalObservations.blockNumber),
    )
    .limit(limit);

  const blockNumbers = blockNumberRows.flatMap((r) => (r.blockNumber != null ? [r.blockNumber] : []));
  if (blockNumbers.length === 0) return [];

  // No LIMIT here on purpose (see the module comment above) - every row for
  // every selected block number, however many that turns out to be.
  // `id` is a secondary sort key purely to make same-blockNumber sibling
  // order deterministic across runs (uuid comparison order is arbitrary but
  // stable, unlike relying on the database's unspecified default row order
  // for ties) - it carries no meaning about which sibling is "more canonical."
  const rows = await db
    .select({
      id: historicalObservations.id,
      blockNumber: historicalObservations.blockNumber,
      blockHash: historicalObservations.blockHash,
    })
    .from(historicalObservations)
    .where(and(...baseConditions, inArray(historicalObservations.blockNumber, blockNumbers)))
    .orderBy(asc(historicalObservations.blockNumber), asc(historicalObservations.id));

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
