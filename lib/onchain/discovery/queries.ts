import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, discoveredPools } from "@/lib/database/schema";
import type { FactoryDeployment } from "./config";
import type { DecodedPairCreated } from "./scan";

export interface DiscoveredPoolRow {
  id: string;
  chainId: string;
  deploymentKey: string;
  factoryAddress: string;
  poolAddress: string;
  token0Address: string;
  token1Address: string;
  creationBlockNumber: string;
  creationBlockHash: string;
  creationTransactionHash: string;
  creationLogIndex: number;
  status: "discovered" | "active" | "rejected";
}

// Idempotent batch upsert, targeting discovered_pools_chain_address_unique
// (schema.ts) - the exact identity a re-scanned range's PairCreated events
// must collide against: the same real pool, re-discovered from an
// overlapping scan window or a repeated cron run, must never create a
// duplicate row (Section 25's "same factory event twice -> one pool").
//
// A pool's status/validation state is NEVER reset by an ordinary
// re-discovery - the `where` clause below only lets the conflict branch
// touch an existing row when its status is "rejected", refreshing its
// creation-event provenance and putting it back to "discovered" for a
// fresh validation pass. This is Section 9's canonical-replacement path:
// a candidate rejected because its creation block was reorged out (see
// validate.ts's "reorged" branch) would otherwise stay permanently
// rejected even after the real, canonical creation event for the exact
// same pool address is later re-discovered (a genuinely valid pool must
// not be locked out forever by one stale, non-canonical observation of
// it). A row rejected for any OTHER reason (bad factory lineage, malformed
// token decimals) is harmlessly re-validated too and will simply be
// rejected again, deterministically, for the same real reason - this is
// not gated more narrowly by matching rejectionReason text, since that
// would be a fragile, string-matching-based distinction for no real safety
// benefit (re-validating an already-correctly-rejected pool is a wasted
// RPC round-trip at worst, never a correctness risk). An "active" or
// already-"discovered" row is never touched by this upsert.
export async function recordDiscoveredPools(chainId: string, deployment: FactoryDeployment, candidates: readonly DecodedPairCreated[]): Promise<number> {
  if (candidates.length === 0) return 0;

  const rows = await db
    .insert(discoveredPools)
    .values(
      candidates.map((c) => ({
        chainId,
        deploymentKey: deployment.key,
        factoryAddress: deployment.factoryAddress,
        // Lowercased at this persistence boundary, not at decode time
        // (scan.ts's own decode output stays a faithful, unmodified
        // representation of what the chain actually returned - useful for
        // testability and for anything that later wants the real EIP-55
        // checksum form). EVM addresses are case-INSENSITIVE identity (the
        // mixed-case form is a checksum encoding, not a different
        // address) - discovered_pools_chain_address_unique is a plain
        // varchar comparison at the DB level, so a real pool re-discovered
        // with different casing (or one whose casing happens to differ
        // from an existing curated `pools` row for the same real address)
        // would otherwise silently bypass this uniqueness/collision check
        // entirely.
        poolAddress: c.poolAddress.toLowerCase(),
        token0Address: c.token0.toLowerCase(),
        token1Address: c.token1.toLowerCase(),
        creationBlockNumber: c.blockNumber.toString(),
        creationBlockHash: c.blockHash,
        creationTransactionHash: c.transactionHash,
        creationLogIndex: c.logIndex,
      })),
    )
    .onConflictDoUpdate({
      target: [discoveredPools.chainId, discoveredPools.poolAddress],
      set: {
        creationBlockNumber: sql`excluded.creation_block_number`,
        creationBlockHash: sql`excluded.creation_block_hash`,
        creationTransactionHash: sql`excluded.creation_transaction_hash`,
        creationLogIndex: sql`excluded.creation_log_index`,
        status: "discovered",
        rejectionReason: null,
        validatedAt: null,
        updatedAt: new Date(),
      },
      setWhere: eq(discoveredPools.status, "rejected"),
    })
    .returning({ id: discoveredPools.id });

  return rows.length;
}

// Bounded read of not-yet-validated candidates for one deployment -
// deliberately never called without a limit (Section 16's "bounded
// per-run work" - the same discipline every other batch read in this app
// already follows, e.g. volume/reorg.ts's DEFAULT_BATCH_SIZE). A page
// left over from this run is simply picked up next run; there is no
// unbounded "validate everything now" path.
//
// Ordered by (creationBlockNumber, creationLogIndex, id) - a deterministic
// FIFO, oldest-discovered-first order (Section 18's own fairness
// requirement), not whatever arbitrary order Postgres's heap scan happens
// to return. Without an explicit ORDER BY, a bounded LIMIT read has no
// guarantee of ever converging on the full pending set across repeated
// calls - the same page (or a re-shuffled subset) could keep being
// returned indefinitely. `id` is the final tiebreak for the vanishingly
// rare case of two candidates sharing the exact same creation block AND
// log index (cannot happen for genuinely distinct real events, but the
// ordering must still be total/deterministic either way).
export async function getPendingDiscoveredPools(deploymentKey: string, limit: number): Promise<DiscoveredPoolRow[]> {
  return db
    .select({
      id: discoveredPools.id,
      chainId: discoveredPools.chainId,
      deploymentKey: discoveredPools.deploymentKey,
      factoryAddress: discoveredPools.factoryAddress,
      poolAddress: discoveredPools.poolAddress,
      token0Address: discoveredPools.token0Address,
      token1Address: discoveredPools.token1Address,
      creationBlockNumber: discoveredPools.creationBlockNumber,
      creationBlockHash: discoveredPools.creationBlockHash,
      creationTransactionHash: discoveredPools.creationTransactionHash,
      creationLogIndex: discoveredPools.creationLogIndex,
      status: discoveredPools.status,
    })
    .from(discoveredPools)
    .where(and(eq(discoveredPools.deploymentKey, deploymentKey), eq(discoveredPools.status, "discovered")))
    .orderBy(asc(discoveredPools.creationBlockNumber), asc(discoveredPools.creationLogIndex), asc(discoveredPools.id))
    .limit(limit);
}

export async function markDiscoveredPoolRejected(id: string, reason: string): Promise<void> {
  await db.update(discoveredPools).set({ status: "rejected", rejectionReason: reason, validatedAt: new Date(), updatedAt: new Date() }).where(eq(discoveredPools.id, id));
}

export async function markDiscoveredPoolActive(
  id: string,
  token0Decimals: number,
  token1Decimals: number,
  poolId: string,
  token0Symbol: string | null = null,
  token1Symbol: string | null = null,
): Promise<void> {
  await db
    .update(discoveredPools)
    .set({ status: "active", token0Decimals, token1Decimals, token0Symbol, token1Symbol, validatedAt: new Date(), poolId, rejectionReason: null, updatedAt: new Date() })
    .where(eq(discoveredPools.id, id));
}

export interface ActiveDiscoveredPool {
  id: string;
  deploymentKey: string;
  poolAddress: string;
  token0Address: string;
  token1Address: string;
  token0Decimals: number;
  token1Decimals: number;
  token0Symbol: string | null;
  token1Symbol: string | null;
  creationBlockNumber: string;
  chainSlug: string;
}

// Every "active" (validated, not reorg-invalidated) discovered pool,
// joined to its chain's own slug - what volume-source.ts maps into the
// same VolumeSourcePool shape config-curated pools already use. Excludes
// reorg-invalidated rows (Section 9/22: an orphaned discovery must never
// keep claiming eligibility merely because it was once accepted) without
// ever deleting them - same mark-never-delete discipline as everywhere
// else in this app.
export async function getActiveDiscoveredPools(): Promise<ActiveDiscoveredPool[]> {
  const rows = await db
    .select({
      id: discoveredPools.id,
      deploymentKey: discoveredPools.deploymentKey,
      poolAddress: discoveredPools.poolAddress,
      token0Address: discoveredPools.token0Address,
      token1Address: discoveredPools.token1Address,
      token0Decimals: discoveredPools.token0Decimals,
      token1Decimals: discoveredPools.token1Decimals,
      token0Symbol: discoveredPools.token0Symbol,
      token1Symbol: discoveredPools.token1Symbol,
      creationBlockNumber: discoveredPools.creationBlockNumber,
      chainSlug: chains.slug,
    })
    .from(discoveredPools)
    .innerJoin(chains, eq(discoveredPools.chainId, chains.id))
    .where(and(eq(discoveredPools.status, "active"), isNull(discoveredPools.reorgInvalidatedAt)));

  // token0Decimals/token1Decimals are only null pre-validation (status
  // "discovered"/"rejected") - an "active" row always has both set by
  // markDiscoveredPoolActive, but the column itself stays nullable at the
  // schema level (Section 7's "never defaulted" discipline), so this is a
  // defensive narrowing, not an expected filter.
  return rows.filter((r): r is typeof r & { token0Decimals: number; token1Decimals: number } => r.token0Decimals != null && r.token1Decimals != null);
}
