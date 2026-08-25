import "dotenv/config";
import postgres from "postgres";
import { closeDb } from "../../lib/database/client";
import { getIndexingState, updateIndexingState } from "../../lib/indexing/state";
import { getObservationsNeedingRecheck, getVerifiedPoolEntities } from "../../lib/database/queries/onchain-recheck";
import { checkBlockHashStillCanonical, readBlockHashOnChain } from "../../lib/onchain/reorg";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

// Phase 5.1: turns the reorg-detection primitive Phase 4 already built and
// tested (lib/onchain/reorg.ts's checkBlockHashStillCanonical) into a real,
// scheduled job - closing the one concrete correctness gap the Phase 5
// audit found in what's already shipped: a native pool TVL observation is
// pinned to a block hash at write time, but nothing ever checks whether
// that block later got reorged off the canonical chain.
//
// Deliberately reuses, rather than re-implements, every piece of existing
// infrastructure this touches:
//   - lib/onchain/reorg.ts (checkBlockHashStillCanonical, readBlockHashOnChain) - unmodified
//   - lib/chains/rpc-resilient-client.ts (via readBlockHashOnChain) - unmodified
//   - lib/indexing/state.ts (indexingState cursor table, GREATEST-protected
//     upsert) - unmodified, just a new set of `component` keys
//   - lib/observability/{logger,sync-run}.ts - unmodified
//   - the advisory-lock-guards-a-cron pattern from workers/retention/rollup.ts
//
// Scope, and a real gap this surfaces rather than papers over: only the 6
// VERIFIED_POOLS entries (lib/onchain/config.ts) have anything to recheck
// against. recordPoolVerification (verify-pool.ts) pins a real blockHash
// into historical_observations for those; verifyAllProtocolTvls
// (verify-protocol-tvl.ts) never writes to historical_observations at all,
// and onchain_verifications (the table it does write) has no blockHash
// column (schema.ts) - so the 2 VERIFIED_PROTOCOL_TVLS entries (Lido, Aave)
// have zero block-hash provenance anywhere to check. Giving them a fake or
// best-effort recheck would be worse than admitting the gap: this job
// covers exactly the 6 reads that have real provenance, and the other 2 are
// reported, not silently skipped or faked. See docs/native-data.md and this
// task's own final report for that limitation.
//
// Similarly, a detected reorg is never used to delete or mutate a
// historical_observations row: that table has no "this observation was
// reorged" column (a schema change, out of scope here per the task's own
// instruction to STOP and report rather than invent one), so the durable
// record of "this was flagged" lives in this run's own sync_runs row and
// structured logs, and in indexingState's per-entity `status`/`error`
// fields - both real, existing, append-only-safe places to record it,
// never a mutation of provenance data itself.

const RECHECK_COMPONENT_PREFIX = "reorg-recheck:pool:";

// Small enough that a normal run (currently 6 real pools) completes in one
// pass; large enough to have headroom once Phase 5's protocol-adapter work
// (see the Phase 5 roadmap) grows VERIFIED_POOLS well past today's count
// without silently starting to leave entities unchecked every run.
const DEFAULT_BATCH_SIZE = 20;

// At ~2 new observations/pool between hourly recheck runs (verify-onchain
// runs every 30 min - vercel.json), 5 comfortably covers a missed run or
// two. Also doubles as the cold-start window size (see
// getObservationsNeedingRecheck) - a brand-new (chainSlug, component) cursor
// checks the 5 most recent observations, not the pool's entire history back
// to Phase 4's merge.
const DEFAULT_LOOKBACK_DEPTH = 5;

// Arbitrary key, unique among this app's advisory-lock users - the only
// other one is workers/retention/rollup.ts's ROLLUP_ADVISORY_LOCK_KEY
// (728140501). Session-scoped (pg_try_advisory_lock / pg_advisory_unlock on
// one reserved connection), not the transaction-scoped
// pg_try_advisory_xact_lock rollup.ts uses: rollup's own lock only ever
// needs to cover a few fast in-transaction DELETEs, but this job's
// protected section spans slow, unpredictable RPC calls across multiple
// chains (with retry/backoff up to a few seconds each - see
// rpc-resilient-client.ts) that must never run inside one open Postgres
// transaction. A session lock held across that whole span, on a connection
// reserved just for the lock (never used for any other query), is the
// smallest mechanism that actually protects the real risk here (a slow run
// overlapping the next scheduled tick), at the cost of an explicit
// acquire/release instead of an automatic transaction-scoped release - the
// `finally` below is what makes that safe.
export const REORG_RECHECK_ADVISORY_LOCK_KEY = 851902733;

export interface ReorgRecheckOptions {
  batchSize?: number;
  lookbackDepth?: number;
  // Restricts which chains' pools get considered this run. Omitted = every
  // chain a verified pool exists on.
  chainSlugs?: string[];
  // Test-only override, same shape/purpose as syncPoolsFromConfig's
  // `poolsToSync` param (lib/onchain/pools.ts) - lets a test exercise
  // batch/lookback/multi-chain behavior against synthetic entities instead
  // of the real 6-pool VERIFIED_POOLS config.
  poolEntitiesOverride?: { poolId: string; configKey: string; chainSlug: string }[];
  // Test-only override for the block-hash reader, same DI shape
  // checkBlockHashStillCanonical itself already takes - avoids a live RPC
  // call in tests. Defaults to the real readBlockHashOnChain.
  readBlockHash?: (chainSlug: string, blockNumber: bigint) => Promise<string | null>;
}

export interface ReorgedObservation {
  observationId: string;
  blockNumber: string;
  storedBlockHash: string;
  currentBlockHash: string | null;
}

export interface ReorgRecheckEntityResult {
  poolKey: string;
  chainSlug: string;
  checked: number;
  confirmed: number;
  reorged: number;
  unknown: number;
  reorgedObservations: ReorgedObservation[];
}

export interface ReorgRecheckStats {
  entitiesConsidered: number;
  entitiesProcessed: number;
  entitiesSkippedBatchLimit: number;
  totalChecked: number;
  totalConfirmed: number;
  totalReorged: number;
  totalUnknown: number;
  perEntity: ReorgRecheckEntityResult[];
}

async function recheckOneEntity(
  entity: { poolId: string; configKey: string; chainSlug: string },
  lookbackDepth: number,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null>,
): Promise<ReorgRecheckEntityResult | null> {
  const component = `${RECHECK_COMPONENT_PREFIX}${entity.configKey}`;

  const state = await getIndexingState(entity.chainSlug, component);
  const cursor = state?.lastProcessedBlock ?? null;

  const candidates = await getObservationsNeedingRecheck(entity.poolId, cursor, lookbackDepth);
  if (candidates.length === 0) return null; // nothing to do - doesn't consume a batch slot, doesn't touch indexingState

  await updateIndexingState(entity.chainSlug, component, { status: "running", lastAttemptedSyncAt: new Date() });

  const result: ReorgRecheckEntityResult = {
    poolKey: entity.configKey,
    chainSlug: entity.chainSlug,
    checked: 0,
    confirmed: 0,
    reorged: 0,
    unknown: 0,
    reorgedObservations: [],
  };

  let newCursor: bigint | null = null;
  let stoppedOnUnknown = false;

  for (const candidate of candidates) {
    // Captures the underlying failure message for logging without changing
    // checkBlockHashStillCanonical's own contract or behavior at all - it
    // still receives and reacts to the same throw exactly as Phase 4 built
    // it (reorg.ts is not modified by this task).
    let readError: string | null = null;
    const reader = async (blockNumber: bigint) => {
      try {
        return await readBlockHash(entity.chainSlug, blockNumber);
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    };

    const check = await checkBlockHashStillCanonical(candidate.blockNumber, candidate.blockHash, reader);
    result.checked++;

    if (check.status === "confirmed") {
      result.confirmed++;
      newCursor = candidate.blockNumber;
      logger.info("reorg recheck: observation still canonical", {
        component: "onchain-reorg-recheck",
        poolKey: entity.configKey,
        chain: entity.chainSlug,
        blockNumber: candidate.blockNumber.toString(),
      });
      continue;
    }

    if (check.status === "reorged") {
      result.reorged++;
      newCursor = candidate.blockNumber;
      result.reorgedObservations.push({
        observationId: candidate.id,
        blockNumber: candidate.blockNumber.toString(),
        storedBlockHash: candidate.blockHash,
        currentBlockHash: check.currentBlockHash,
      });
      logger.warn("reorg recheck: observation no longer canonical - chain reorged past this block", {
        component: "onchain-reorg-recheck",
        poolKey: entity.configKey,
        chain: entity.chainSlug,
        blockNumber: candidate.blockNumber.toString(),
        storedBlockHash: candidate.blockHash,
        currentBlockHash: check.currentBlockHash,
      });
      continue;
    }

    // "unknown" - never treated as confirmed or reorged (see
    // checkBlockHashStillCanonical), and never advanced past: the next run
    // retries this exact observation instead of silently accepting an
    // inconclusive read as resolved.
    result.unknown++;
    logger.warn("reorg recheck: inconclusive - could not read current block hash", {
      component: "onchain-reorg-recheck",
      poolKey: entity.configKey,
      chain: entity.chainSlug,
      blockNumber: candidate.blockNumber.toString(),
      error: readError,
    });
    stoppedOnUnknown = true;
    break;
  }

  const hadReorg = result.reorged > 0;
  await updateIndexingState(entity.chainSlug, component, {
    status: stoppedOnUnknown || hadReorg ? "error" : "idle",
    error: hadReorg
      ? `reorg detected in ${result.reorged} observation(s) - see sync_runs/logs for this run`
      : stoppedOnUnknown
        ? "RPC read failed while rechecking - will retry next run"
        : null,
    lastSuccessfulSyncAt: new Date(),
    ...(newCursor != null ? { lastProcessedBlock: newCursor } : {}),
  });

  return result;
}

// Returns null when another invocation already holds the lock (mirrors
// workers/retention/rollup.ts's own null-means-skipped convention) - never
// throws for that case, since a contended lock is an expected, routine
// outcome, not a failure.
async function runRecheck(options: ReorgRecheckOptions = {}): Promise<ReorgRecheckStats | null> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lookbackDepth = options.lookbackDepth ?? DEFAULT_LOOKBACK_DEPTH;
  const readBlockHash = options.readBlockHash ?? readBlockHashOnChain;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const lockConn = postgres(connectionString, { max: 1, prepare: false });
  let locked = false;

  try {
    const [{ locked: acquired }] = await lockConn`select pg_try_advisory_lock(${REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
    locked = acquired;
    if (!locked) {
      logger.warn("reorg recheck already in progress in another invocation, skipping this run", {
        component: "onchain-reorg-recheck",
      });
      return null;
    }

    let entities = options.poolEntitiesOverride ?? (await getVerifiedPoolEntities());
    if (options.chainSlugs) {
      const allowed = new Set(options.chainSlugs);
      entities = entities.filter((e) => allowed.has(e.chainSlug));
    }

    const stats: ReorgRecheckStats = {
      entitiesConsidered: entities.length,
      entitiesProcessed: 0,
      entitiesSkippedBatchLimit: 0,
      totalChecked: 0,
      totalConfirmed: 0,
      totalReorged: 0,
      totalUnknown: 0,
      perEntity: [],
    };

    for (const entity of entities) {
      if (stats.entitiesProcessed >= batchSize) {
        // Only entities that actually had candidates count against the
        // batch limit (see below) - but we can't know that without
        // querying, and querying is cheap/local (unlike the RPC reads that
        // follow), so the cap is enforced right before the expensive part:
        // an entity that would have had zero candidates anyway never should
        // have been "skipped" in any meaningful sense, but distinguishing
        // that here would mean querying it anyway, defeating the point of
        // capping work. Recorded as skipped either way - safe and simply
        // conservative, never under-reports.
        stats.entitiesSkippedBatchLimit++;
        continue;
      }

      const result = await recheckOneEntity(entity, lookbackDepth, readBlockHash);
      if (result === null) continue; // nothing needed rechecking - doesn't consume the batch budget

      stats.entitiesProcessed++;
      stats.totalChecked += result.checked;
      stats.totalConfirmed += result.confirmed;
      stats.totalReorged += result.reorged;
      stats.totalUnknown += result.unknown;
      stats.perEntity.push(result);
    }

    return stats;
  } finally {
    if (locked) {
      await lockConn`select pg_advisory_unlock(${REORG_RECHECK_ADVISORY_LOCK_KEY})`;
    }
    await lockConn.end();
  }
}

export async function recheckPoolTvlReorgs(options?: ReorgRecheckOptions): Promise<ReorgRecheckStats | null> {
  return withSyncRun("reorg-recheck", async () => {
    const stats = await runRecheck(options);
    if (stats === null) {
      return {
        result: null,
        stats: { recordsProcessed: 0, metadata: { skipped: "already running elsewhere" } },
        outcome: "partial" as const,
      };
    }

    return {
      result: stats,
      stats: {
        recordsProcessed: stats.totalChecked,
        errorCount: stats.totalReorged + stats.totalUnknown,
        metadata: {
          entitiesConsidered: stats.entitiesConsidered,
          entitiesProcessed: stats.entitiesProcessed,
          entitiesSkippedBatchLimit: stats.entitiesSkippedBatchLimit,
          totalConfirmed: stats.totalConfirmed,
          totalReorged: stats.totalReorged,
          totalUnknown: stats.totalUnknown,
          reorgedObservations: stats.perEntity.flatMap((e) =>
            e.reorgedObservations.map((o) => ({ poolKey: e.poolKey, chain: e.chainSlug, ...o })),
          ),
        },
      },
      // "partial" whenever anything is reorged or inconclusive - lets the
      // health view distinguish "every rechecked observation is still
      // canonical" from "something needs attention," matching
      // workers/onchain/verify.ts's own success-vs-partial convention.
      outcome: stats.totalReorged + stats.totalUnknown > 0 ? ("partial" as const) : ("success" as const),
    };
  });
}

if (require.main === module) {
  recheckPoolTvlReorgs()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("reorg recheck failed", { component: "onchain-reorg-recheck", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
