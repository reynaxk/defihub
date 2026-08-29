import postgres from "postgres";
import { getObservationsNeedingRecheck, markObservationReorged } from "@/lib/database/queries/onchain-recheck";
import { getIndexingState, updateIndexingState } from "@/lib/indexing/state";
import { getAllVolumeSourcePools } from "@/lib/onchain/discovery/volume-source";
import { checkBlockHashStillCanonical, readBlockHashOnChain, type ReorgCheckResult } from "@/lib/onchain/reorg";
import { logger } from "@/lib/observability/logger";
import { withSyncRun } from "@/lib/observability/sync-run";
import type { VolumeSourcePool } from "./config";
import { getPoolIdByConfigKey, getSwapEventsNeedingRecheck, markSwapEventsReorged } from "./queries";

// A dedicated, deliberately SEPARATE reorg-recheck path for Phase 5.4's own
// data, rather than a fourth generalization of
// workers/onchain/recheck-reorgs.ts's existing pool/vault/token machinery -
// for one concrete, load-bearing reason, not just caution for its own sake.
//
// recheckOneEntity (recheck-reorgs.ts) derives its indexingState cursor key
// as `reorg-recheck:${entityType}:${configKey}` - it does NOT include
// `metric`. That's safe today because every existing entityType has
// exactly one recheckable metric (pool/vault: "tvl_usd", token:
// "price_usd" - see that file's own module comment). This pool's own
// config key ("uniswap-v2-eth-usdc-weth") is ALREADY a real entityType
// "pool" entry in that job via getVerifiedPoolEntities (its "tvl_usd"
// observations, written by verify-pool.ts). If this module fed the SAME
// entityType "pool" + configKey into that job's RecheckEntity list, tagged
// with metric "volume_usd" instead, it would collide on the exact same
// cursor key as the pool's own tvl_usd entry - two metrics with completely
// independent, differently-paced block-number sequences silently sharing
// one lastProcessedBlock, corrupting both. Fixing that at the source would
// mean changing recheckOneEntity's cursor-key formula, a shared function
// three already-shipped phases (5.1/5.2/5.3) depend on working exactly as
// it does today - out of safe scope for this phase (Section 39). A
// separate module with its own, metric-inclusive component-key namespace
// (see COMPONENT_PREFIX below) sidesteps the collision entirely, at the
// cost of a small amount of duplicated shape rather than a shared-code
// regression risk.
//
// What IS reused, unmodified: checkBlockHashStillCanonical/
// readBlockHashOnChain (lib/onchain/reorg.ts), getIndexingState/
// updateIndexingState (lib/indexing/state.ts), and - for the aggregate
// historicalObservations side only - getObservationsNeedingRecheck/
// markObservationReorged (lib/database/queries/onchain-recheck.ts), which
// are pure (entityType, entityId, metric) parameterized query functions
// with no component-key logic of their own at all; the collision above
// lives entirely in recheck-reorgs.ts's own cursor-key formula, not in
// these query functions, so calling them directly here with this module's
// own cursor is safe reuse, not a workaround.
const COMPONENT_PREFIX = "volume-reorg-recheck";

// Distinct from recheck-reorgs.ts's REORG_RECHECK_ADVISORY_LOCK_KEY
// (851902733) and workers/retention/rollup.ts's ROLLUP_ADVISORY_LOCK_KEY
// (728140501) - every advisory-lock user in this app must use a unique key.
export const VOLUME_REORG_RECHECK_ADVISORY_LOCK_KEY = 402917588;

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LOOKBACK_DEPTH = 20;
const LOCK_CONNECTION_TIMEOUT_SECONDS = 10;
const LOCK_IDLE_TIMEOUT_SECONDS = 60;

const AGGREGATE_METRICS = ["volume_usd", "fees_usd", "revenue_usd"] as const;

export interface VolumeReorgRecheckOptions {
  batchSize?: number;
  lookbackDepth?: number;
  poolsOverride?: VolumeSourcePool[];
  readBlockHash?: (chainSlug: string, blockNumber: bigint) => Promise<string | null>;
}

export interface VolumeReorgRecheckStats {
  poolsConsidered: number;
  poolsFailed: number;
  swapEventsChecked: number;
  swapEventsReorged: number;
  swapEventsUnknown: number;
  observationsChecked: number;
  observationsReorged: number;
  observationsUnknown: number;
}

// The identity every recheck candidate (a raw swap_events row, or an
// aggregate historical_observations row) shares - both
// SwapEventRecheckCandidate (queries.ts) and RecheckCandidate
// (onchain-recheck.ts) already have exactly this shape.
interface RecheckCandidateLike {
  id: string;
  blockNumber: bigint;
  blockHash: string;
}

interface RecheckWorkflowResult {
  checked: number;
  reorged: number;
  unknown: number;
}

// CodeRabbit fix round: recheckSwapEvents and recheckAggregateMetric
// (below) were near-identical copies of the same cursor-load ->
// candidate-fetch -> block-group -> canonical-check -> mark-reorged ->
// cursor-advance workflow, differing only in WHERE candidates come from
// and HOW a reorged one gets marked. Extracted here into one generic
// helper, parameterized by exactly those two differences (plus the
// operation-specific error-message text each caller already had) -
// centralizing the actual mechanics (cursor handling, block grouping,
// canonical-hash checks, unknown-result stop condition, cursor
// advancement, result counting, indexing-state updates) in one place,
// while each caller keeps its own candidate query, reorg-marking function,
// and error text exactly as before.
//
// Also where the canonical block-hash read cache lives (fix for a
// SEPARATE finding): two candidates that share the exact same
// (blockNumber, blockHash) pair - the common case of multiple swaps or
// multiple metrics landing on the same block - previously triggered one
// checkBlockHashStillCanonical/readBlockHash call EACH, even though the
// answer is identical for both. The cache is keyed on `${blockNumber}:
// ${blockHash}` together, not blockNumber alone: two candidates that share
// a block number but have DIFFERENT block hashes (a real, meaningful case
// - one is the orphaned pre-reorg row, the other the new canonical row at
// the same height, see fix #1's own schema change) must never share a
// cached verdict, since the chain's current hash at that height can only
// match one of them. `checked` still counts every candidate row inspected
// (the stat this run reports is "how much data was verified," not "how
// many RPC calls were made") - only the underlying RPC call itself is
// deduplicated.
async function runRecheckWorkflow<C extends RecheckCandidateLike>(params: {
  chainSlug: string;
  component: string;
  loadCandidates: (cursor: bigint | null, limit: number) => Promise<C[]>;
  markReorged: (ids: string[], invalidatedAt: Date) => Promise<void>;
  lookbackDepth: number;
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null>;
  onReorged: (candidate: C) => void;
  errorMessagePrefix: string;
}): Promise<RecheckWorkflowResult> {
  const { chainSlug, component, loadCandidates, markReorged, lookbackDepth, readBlockHash, onReorged, errorMessagePrefix } = params;

  const state = await getIndexingState(chainSlug, component);
  const cursor = state?.lastProcessedBlock ?? null;

  const candidates = await loadCandidates(cursor, lookbackDepth);
  const result: RecheckWorkflowResult = { checked: 0, reorged: 0, unknown: 0 };
  if (candidates.length === 0) return result;

  await updateIndexingState(chainSlug, component, { status: "running", lastAttemptedSyncAt: new Date() });

  const groups: { blockNumber: bigint; items: C[] }[] = [];
  for (const c of candidates) {
    const last = groups[groups.length - 1];
    if (last && last.blockNumber === c.blockNumber) last.items.push(c);
    else groups.push({ blockNumber: c.blockNumber, items: [c] });
  }

  const hashCheckCache = new Map<string, Promise<ReorgCheckResult>>();
  let newCursor: bigint | null = null;
  let stoppedOnUnknown = false;

  for (const group of groups) {
    const reorgedIds: string[] = [];
    let groupHasUnknown = false;

    for (const candidate of group.items) {
      const cacheKey = `${candidate.blockNumber}:${candidate.blockHash}`;
      let checkPromise = hashCheckCache.get(cacheKey);
      if (!checkPromise) {
        checkPromise = checkBlockHashStillCanonical(candidate.blockNumber, candidate.blockHash, (bn) => readBlockHash(chainSlug, bn));
        hashCheckCache.set(cacheKey, checkPromise);
      }
      const check = await checkPromise;
      result.checked++;

      if (check.status === "confirmed") continue;
      if (check.status === "reorged") {
        result.reorged++;
        reorgedIds.push(candidate.id);
        onReorged(candidate);
        continue;
      }
      result.unknown++;
      groupHasUnknown = true;
    }

    if (reorgedIds.length > 0) await markReorged(reorgedIds, new Date());
    if (groupHasUnknown) {
      stoppedOnUnknown = true;
      break;
    }
    newCursor = group.blockNumber;
  }

  await updateIndexingState(chainSlug, component, {
    status: stoppedOnUnknown ? "error" : "idle",
    error: stoppedOnUnknown ? `${errorMessagePrefix} - will retry next run` : null,
    ...(!stoppedOnUnknown ? { lastSuccessfulSyncAt: new Date() } : {}),
    ...(newCursor != null ? { lastProcessedBlock: newCursor } : {}),
  });

  return result;
}

// Rechecks one pool's raw swap_events - see runRecheckWorkflow above for
// the shared mechanics; this is now just its candidate query, mark
// function, and log text.
function recheckSwapEvents(
  pool: VolumeSourcePool,
  poolId: string,
  lookbackDepth: number,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null>,
): Promise<RecheckWorkflowResult> {
  return runRecheckWorkflow({
    chainSlug: pool.chainSlug,
    component: `${COMPONENT_PREFIX}:pool:${pool.key}:swap-events`,
    loadCandidates: (cursor, limit) => getSwapEventsNeedingRecheck(poolId, cursor, limit),
    markReorged: markSwapEventsReorged,
    lookbackDepth,
    readBlockHash,
    errorMessagePrefix: "RPC read failed while rechecking swap events",
    onReorged: (candidate) =>
      logger.warn("volume reorg recheck: swap event no longer canonical", {
        component: "onchain-volume-reorg-recheck",
        chain: pool.chainSlug,
        pool: pool.key,
        blockNumber: candidate.blockNumber.toString(),
      }),
  });
}

// Rechecks one pool's aggregate observations (volume_usd/fees_usd/
// revenue_usd) for one metric - same shared mechanics, its own candidate
// query (the generic, entityType/metric-parameterized
// getObservationsNeedingRecheck - see this module's own header comment for
// why calling it directly here, with this module's own cursor, is safe)
// and its own mark function (wrapped to the bulk shape runRecheckWorkflow
// expects, since markObservationReorged itself only marks one row at a
// time).
function recheckAggregateMetric(
  pool: VolumeSourcePool,
  poolId: string,
  metric: (typeof AGGREGATE_METRICS)[number],
  lookbackDepth: number,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null>,
): Promise<RecheckWorkflowResult> {
  return runRecheckWorkflow({
    chainSlug: pool.chainSlug,
    component: `${COMPONENT_PREFIX}:pool:${pool.key}:${metric}`,
    loadCandidates: (cursor, limit) => getObservationsNeedingRecheck("pool", poolId, metric, cursor, limit),
    markReorged: async (ids, invalidatedAt) => {
      await Promise.all(ids.map((id) => markObservationReorged(id, invalidatedAt)));
    },
    lookbackDepth,
    readBlockHash,
    errorMessagePrefix: `RPC read failed while rechecking ${metric}`,
    onReorged: (candidate) =>
      logger.warn("volume reorg recheck: aggregate observation no longer canonical", {
        component: "onchain-volume-reorg-recheck",
        chain: pool.chainSlug,
        pool: pool.key,
        metric,
        blockNumber: candidate.blockNumber.toString(),
      }),
  });
}

async function runVolumeReorgRecheck(options: VolumeReorgRecheckOptions = {}): Promise<VolumeReorgRecheckStats | null> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lookbackDepth = options.lookbackDepth ?? DEFAULT_LOOKBACK_DEPTH;
  const readBlockHash = options.readBlockHash ?? readBlockHashOnChain;
  // Phase 5.9: config-curated pools PLUS discovery-validated "active"
  // pools - a discovered pool's own swap_events/observations must be
  // reorg-rechecked by the exact same job as everything else, not a
  // second, discovery-specific recheck path. `poolsOverride` (tests) skips
  // the DB read entirely, same as before.
  const poolsToCheck = options.poolsOverride ?? (await getAllVolumeSourcePools());

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const lockConn = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: LOCK_CONNECTION_TIMEOUT_SECONDS,
    idle_timeout: LOCK_IDLE_TIMEOUT_SECONDS,
  });
  let locked = false;

  try {
    const [{ locked: acquired }] = await lockConn`select pg_try_advisory_lock(${VOLUME_REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
    locked = acquired;
    if (!locked) {
      logger.warn("volume reorg recheck already in progress in another invocation, skipping this run", {
        component: "onchain-volume-reorg-recheck",
      });
      return null;
    }

    const stats: VolumeReorgRecheckStats = {
      poolsConsidered: poolsToCheck.length,
      poolsFailed: 0,
      swapEventsChecked: 0,
      swapEventsReorged: 0,
      swapEventsUnknown: 0,
      observationsChecked: 0,
      observationsReorged: 0,
      observationsUnknown: 0,
    };

    for (const pool of poolsToCheck.slice(0, batchSize)) {
      try {
        const poolId = await getPoolIdByConfigKey(pool.key);
        if (!poolId) {
          logger.warn("volume reorg recheck: pool not yet synced, skipping", { component: "onchain-volume-reorg-recheck", pool: pool.key });
          continue;
        }

        const swapResult = await recheckSwapEvents(pool, poolId, lookbackDepth, readBlockHash);
        stats.swapEventsChecked += swapResult.checked;
        stats.swapEventsReorged += swapResult.reorged;
        stats.swapEventsUnknown += swapResult.unknown;

        for (const metric of AGGREGATE_METRICS) {
          const obsResult = await recheckAggregateMetric(pool, poolId, metric, lookbackDepth, readBlockHash);
          stats.observationsChecked += obsResult.checked;
          stats.observationsReorged += obsResult.reorged;
          stats.observationsUnknown += obsResult.unknown;
        }
      } catch (err) {
        stats.poolsFailed++;
        const message = err instanceof Error ? err.message : String(err);
        logger.error("volume reorg recheck: pool failed - continuing with remaining pools", {
          component: "onchain-volume-reorg-recheck",
          pool: pool.key,
          error: message,
        });
      }
    }

    return stats;
  } finally {
    try {
      if (locked) await lockConn`select pg_advisory_unlock(${VOLUME_REORG_RECHECK_ADVISORY_LOCK_KEY})`;
    } finally {
      await lockConn.end();
    }
  }
}

export async function recheckVolumeReorgs(options?: VolumeReorgRecheckOptions): Promise<VolumeReorgRecheckStats | null> {
  return withSyncRun("onchain-volume-reorg-recheck", async () => {
    const stats = await runVolumeReorgRecheck(options);
    if (stats === null) {
      return { result: null, stats: { recordsProcessed: 0, metadata: { skipped: "already running elsewhere" } }, outcome: "partial" as const };
    }

    const totalReorged = stats.swapEventsReorged + stats.observationsReorged;
    const totalUnknown = stats.swapEventsUnknown + stats.observationsUnknown;

    return {
      result: stats,
      stats: {
        recordsProcessed: stats.swapEventsChecked + stats.observationsChecked,
        errorCount: totalReorged + totalUnknown + stats.poolsFailed,
        metadata: { ...stats },
      },
      outcome: totalReorged + totalUnknown + stats.poolsFailed > 0 ? ("partial" as const) : ("success" as const),
    };
  });
}
