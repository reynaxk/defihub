import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, pools, vaults } from "@/lib/database/schema";

// Query support for workers/onchain/recheck-reorgs.ts. Deliberately scoped
// to `pools`/`vaults`/`historical_observations` only - those are the only
// entities that carry real block-hash provenance today. `onchain_verifications`
// (the table VERIFIED_PROTOCOL_TVLS' 2 legacy entries write to) has no
// blockHash column at all, so there is nothing here for one of those
// entries to be rechecked against - see recheck-reorgs.ts's own module
// comment for why that's a reported gap, not something this file works
// around.
//
// "pool" and "vault" (Phase 5.2) are the two entityType values this
// recheck job knows about - see historicalObservations' own schema.ts
// comment for the full list of what entityType can refer to.
export type RecheckEntityType = "pool" | "vault";

export interface RecheckEntity {
  entityType: RecheckEntityType;
  entityId: string;
  configKey: string;
  chainSlug: string;
}

// `pools` is kept in exact sync with VERIFIED_POOLS by syncPoolsFromConfig
// (lib/onchain/pools.ts) on every verification run, and is never populated
// any other way (see that table's own schema.ts comment) - so selecting
// every row here already *is* "the verified pools," with no need to
// reference VERIFIED_POOLS directly or filter further.
export async function getVerifiedPoolEntities(): Promise<RecheckEntity[]> {
  const rows = await db
    .select({ id: pools.id, configKey: pools.configKey, chainSlug: chains.slug })
    .from(pools)
    .innerJoin(chains, eq(chains.id, pools.chainId))
    .orderBy(pools.configKey);
  return rows.map((r) => ({ entityType: "pool" as const, entityId: r.id, configKey: r.configKey, chainSlug: r.chainSlug }));
}

// The exact structural twin of getVerifiedPoolEntities, for VERIFIED_VAULTS
// (lib/onchain/config.ts) / `vaults` (kept in sync by
// lib/onchain/vaults.ts's syncVaultsFromConfig) instead of pools.
export async function getVerifiedVaultEntities(): Promise<RecheckEntity[]> {
  const rows = await db
    .select({ id: vaults.id, configKey: vaults.configKey, chainSlug: chains.slug })
    .from(vaults)
    .innerJoin(chains, eq(chains.id, vaults.chainId))
    .orderBy(vaults.configKey);
  return rows.map((r) => ({ entityType: "vault" as const, entityId: r.id, configKey: r.configKey, chainSlug: r.chainSlug }));
}

export interface RecheckCandidate {
  id: string;
  blockNumber: bigint;
  blockHash: string;
}

// The observations for one entity (a pool or a vault - see RecheckEntityType)
// that still need a reorg recheck this run - bounded by `limit` *distinct
// block numbers* (see below for why rows aren't the right unit to bound),
// so neither a long-paused job nor an entity with months of history can
// turn one run into an unbounded amount of RPC work.
//
// `afterBlockNumber == null` means this entity has no recheck cursor yet
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
  entityType: RecheckEntityType,
  entityId: string,
  afterBlockNumber: bigint | null,
  limit: number,
): Promise<RecheckCandidate[]> {
  // Both columns are nullable at the type level (a pre-blockHash-provenance
  // legacy row - see historicalObservations' own schema comment - could in
  // principle have a null blockNumber too), even though the
  // historical_observations_{pool,vault}_tvl_requires_block_identity CHECK
  // constraints already guarantee both are set together for every
  // tvl_usd row of either entityType going forward. Filtering on both
  // explicitly, rather than trusting the constraint implicitly, keeps this
  // query correct on its own terms and keeps toRecheckCandidate below able
  // to convert without a non-null assertion.
  const baseConditions = [
    eq(historicalObservations.entityType, entityType),
    eq(historicalObservations.entityId, entityId),
    eq(historicalObservations.metric, "tvl_usd"),
    isNotNull(historicalObservations.blockNumber),
    isNotNull(historicalObservations.blockHash),
    // Once a recheck has determined a row's block was reorged away
    // (reorgInvalidatedAt set - see markObservationReorged below), its
    // outcome is settled: there's nothing left to re-verify by reading the
    // chain again, so it's excluded from future candidates the same way it's
    // excluded from canonical history (getPoolTvlHistory, queries/pools.ts).
    isNull(historicalObservations.reorgInvalidatedAt),
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

// Marks one historical_observations row as no longer canonical, without
// touching or deleting anything else about it - every provenance field
// (blockNumber, blockHash, value, calculationInputs, priceSource, ...) stays
// exactly as originally recorded, so the row remains fully available for
// debugging/audit (see reorgInvalidatedAt's own schema.ts comment for the
// full reasoning). A single targeted UPDATE by primary key is naturally
// idempotent - setting the same column on the same row again, if it were
// ever attempted twice, just overwrites the timestamp with another
// non-null value, never creates a duplicate or corrupts anything. In
// practice it's never attempted twice: getObservationsNeedingRecheck
// excludes an already-invalidated row from future candidates, so this only
// ever runs once per observation, at the moment recheck-reorgs.ts first
// determines its block was reorged away.
export async function markObservationReorged(observationId: string, invalidatedAt: Date): Promise<void> {
  await db.update(historicalObservations).set({ reorgInvalidatedAt: invalidatedAt }).where(eq(historicalObservations.id, observationId));
}

// The isNotNull filters above already guarantee both fields are non-null in
// practice - flatMap (returning [] for the impossible case rather than a
// non-null assertion) keeps that a runtime-safe guarantee instead of an
// assumption the type checker just has to trust.
function toRecheckCandidate(row: { id: string; blockNumber: string | null; blockHash: string | null }): RecheckCandidate[] {
  if (row.blockNumber == null || row.blockHash == null) return [];
  return [{ id: row.id, blockNumber: BigInt(row.blockNumber), blockHash: row.blockHash }];
}
