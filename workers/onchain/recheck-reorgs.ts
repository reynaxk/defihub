import "dotenv/config";
import postgres from "postgres";
import { closeDb } from "../../lib/database/client";
import { getIndexingState, updateIndexingState } from "../../lib/indexing/state";
import {
  getObservationsNeedingRecheck,
  getVerifiedPoolEntities,
  getVerifiedTokenPriceEntities,
  getVerifiedVaultEntities,
  markObservationReorged,
  type RecheckEntity,
} from "../../lib/database/queries/onchain-recheck";
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
// Phase 5.2 generalized this job (previously pool-only) to also cover
// VERIFIED_VAULTS' ERC-4626 entries (verify-vault.ts), which write
// block-hash-pinned historical_observations rows the exact same way pools
// do (entityType "vault" instead of "pool" - see RecheckEntity). Phase 5.3
// generalized it a second time, the same way, for lib/onchain/pricing's
// native reference-asset price observations (entityType "token", metric
// "price_usd" instead of "tvl_usd" - see RecheckEntity's own `metric`
// field). No new job, no new lock, no new cron: recheckOneEntity/runRecheck
// below operate on a unified list of pool, vault, AND token entities,
// tagged by entityType, through the same indexingState checkpoints, the
// same advisory lock, and the same
// checkBlockHashStillCanonical/reorgInvalidatedAt mechanics - exactly the
// "do not create a separate indexing mechanism for the new [price] sources"
// instruction both phases were built under.
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
// Scope, and a real gap this surfaces rather than papers over: only
// VERIFIED_POOLS and VERIFIED_VAULTS entries (lib/onchain/config.ts) have
// anything to recheck against. recordPoolVerification (verify-pool.ts) and
// recordVaultVerification (verify-vault.ts) both pin a real blockHash into
// historical_observations; verifyAllProtocolTvls (verify-protocol-tvl.ts) -
// the legacy "direct"/"supply-times-rate" reads (Lido, Aave) predating
// Phase 5.2 - never writes to historical_observations at all, and
// onchain_verifications (the table it does write) has no blockHash column
// (schema.ts), so those 2 entries have zero block-hash provenance anywhere
// to check. Giving them a fake or best-effort recheck would be worse than
// admitting the gap: this job covers exactly the reads that have real
// provenance, and the legacy 2 are reported, not silently skipped or
// faked. See docs/native-data.md and this task's own final report for that
// limitation.
//
// A detected reorg is never used to delete a historical_observations row,
// or to touch any of its provenance fields (blockNumber, blockHash, value,
// calculationInputs, priceSource, ...). The one thing that does change is
// historicalObservations.reorgInvalidatedAt (see that column's own
// schema.ts comment and markObservationReorged in queries/onchain-recheck.ts)
// - set once, the moment a reorg is confirmed, purely so
// getPoolTvlHistory/getPoolObservationCount (queries/pools.ts) and their
// vault twins getVaultTvlHistory/getVaultObservationCount (queries/vaults.ts)
// can exclude it from canonical results without ever rewriting or
// discarding the row itself. The durable "why" - the specific hash mismatch
// this run found -
// still lives in this run's own sync_runs row and structured logs, and in
// indexingState's per-entity `status`/`error` fields, exactly as before.

// The full indexingState `component` key is
// `${RECHECK_COMPONENT_PREFIX}:${entityType}:${configKey}` - for entityType
// "pool" that reproduces the exact string Phase 5.1 already used
// ("reorg-recheck:pool:X"), so existing pool checkpoints keep working
// unchanged; "vault" entities get their own, equally namespaced, series.
const RECHECK_COMPONENT_PREFIX = "reorg-recheck";

// Small enough that a normal run (currently 6 real pools) completes in one
// pass; large enough to have headroom once Phase 5's protocol-adapter work
// (see the Phase 5 roadmap) grows VERIFIED_POOLS well past today's count
// without silently starting to leave entities unchecked every run.
const DEFAULT_BATCH_SIZE = 20;

// At ~2 new observations/pool between hourly recheck runs (verify-onchain
// runs every 30 min - vercel.json), 5 comfortably covers a missed run or
// two. Also doubles as the cold-start window size (see
// getObservationsNeedingRecheck) - a brand-new (chainSlug, component) cursor
// checks the 5 most recent distinct block numbers, not the pool's entire
// history back to Phase 4's merge.
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
// acquire/release instead of an automatic transaction-scoped release - see
// runRecheck's try/finally below for what makes that safe.
export const REORG_RECHECK_ADVISORY_LOCK_KEY = 851902733;

// connect_timeout matches this job's own fail-fast philosophy (see
// RpcUnavailableError's bounded retries) - a lock-only connection should
// fail quickly, not hang. idle_timeout is deliberately NOT the main app
// pool's 20s (lib/database/client.ts) despite "consistent where possible":
// this connection issues exactly two queries (lock, then much later
// unlock) with this job's entire RPC-calling duration sitting idle in
// between - a 20s idle_timeout would routinely fire mid-job and drop the
// connection before the unlock ever runs. 90s comfortably exceeds this
// job's own cron maxDuration (60s, see the route file), so it never fires
// during a normal run; if something still hangs long enough to hit it,
// Postgres itself releases a session-scoped advisory lock automatically on
// disconnect, so a dropped connection here still can't leave the lock
// stuck.
const LOCK_CONNECTION_TIMEOUT_SECONDS = 10;
const LOCK_IDLE_TIMEOUT_SECONDS = 90;

export interface ReorgRecheckOptions {
  batchSize?: number;
  lookbackDepth?: number;
  // Restricts which chains' pools/vaults get considered this run. Omitted =
  // every chain a verified pool or vault exists on.
  chainSlugs?: string[];
  // Test-only override, same shape/purpose as syncPoolsFromConfig's
  // `poolsToSync` param (lib/onchain/pools.ts) - lets a test exercise
  // batch/lookback/multi-chain behavior against synthetic entities instead
  // of the real VERIFIED_POOLS config. Kept in this pool-specific shape
  // (rather than the more general RecheckEntity) so every existing Phase
  // 5.1 test keeps working unchanged - internally mapped to RecheckEntity
  // alongside vaultEntitiesOverride below.
  poolEntitiesOverride?: { poolId: string; configKey: string; chainSlug: string }[];
  // The vault-shaped twin of poolEntitiesOverride, for VERIFIED_VAULTS
  // entities.
  vaultEntitiesOverride?: { vaultId: string; configKey: string; chainSlug: string }[];
  // The token-price-shaped twin, for Phase 5.3's native reference-asset
  // price observations (entityType "token", metric "price_usd").
  tokenEntitiesOverride?: { tokenId: string; configKey: string; chainSlug: string }[];
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
  entityType: RecheckEntity["entityType"];
  entityKey: string;
  chainSlug: string;
  checked: number;
  confirmed: number;
  reorged: number;
  unknown: number;
  reorgedObservations: ReorgedObservation[];
  // Set only when this entity threw and processing moved on to the next
  // one (see runRecheck's per-entity try/catch) - checked/confirmed/etc.
  // all stay 0 in that case, since nothing about this entity was actually
  // resolved this run.
  error?: string;
}

export interface ReorgRecheckStats {
  entitiesConsidered: number;
  entitiesProcessed: number;
  entitiesSkippedBatchLimit: number;
  entitiesFailed: number;
  totalChecked: number;
  totalConfirmed: number;
  totalReorged: number;
  totalUnknown: number;
  perEntity: ReorgRecheckEntityResult[];
}

async function recheckOneEntity(
  entity: RecheckEntity,
  lookbackDepth: number,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null>,
): Promise<ReorgRecheckEntityResult | null> {
  const component = `${RECHECK_COMPONENT_PREFIX}:${entity.entityType}:${entity.configKey}`;

  // The whole body - including getIndexingState/getObservationsNeedingRecheck,
  // not just the processing loop below - is wrapped in this one try/catch so
  // ANY failure for a selected entity (a broken lookup, a DB error reading
  // the cursor, an RPC read, a write) reaches the same catch, which always
  // records that an attempt was made (see lastAttemptedSyncAt in the catch
  // below). Without this, a failure that happens before the "running" update
  // further down - e.g. getObservationsNeedingRecheck itself throwing -
  // would leave lastAttemptedSyncAt untouched, making that entity look
  // permanently "least recently attempted" and starve every other entity by
  // always sorting first in runRecheck's ordering.
  try {
    const state = await getIndexingState(entity.chainSlug, component);
    const cursor = state?.lastProcessedBlock ?? null;

    const candidates = await getObservationsNeedingRecheck(entity.entityType, entity.entityId, entity.metric, cursor, lookbackDepth);
    if (candidates.length === 0) return null; // nothing to do - doesn't consume a batch slot, doesn't touch indexingState

    await updateIndexingState(entity.chainSlug, component, { status: "running", lastAttemptedSyncAt: new Date() });

    // Candidates arrive ordered ascending by (blockNumber, id) - see
    // getObservationsNeedingRecheck, which also guarantees every
    // observation sharing a given blockNumber is present together (never
    // split across a limit boundary). Grouping by blockNumber here, and
    // only advancing the cursor once a WHOLE group resolves cleanly, is
    // what keeps that guarantee meaningful: the reorg-aware identity model
    // deliberately allows two observations for the same pool to share a
    // blockNumber with different blockHash values (same block number,
    // different chain history), so a cursor that advanced on the first
    // sibling alone could silently strand the second one behind a `> `
    // comparison that never revisits it - and if one sibling in a group
    // reads back "unknown" while another resolves cleanly, the group as a
    // whole must still be treated as unresolved (never advance past a
    // block number this run couldn't fully confirm).
    const groups: { blockNumber: bigint; items: typeof candidates }[] = [];
    for (const candidate of candidates) {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.blockNumber === candidate.blockNumber) lastGroup.items.push(candidate);
      else groups.push({ blockNumber: candidate.blockNumber, items: [candidate] });
    }

    const result: ReorgRecheckEntityResult = {
      entityType: entity.entityType,
      entityKey: entity.configKey,
      chainSlug: entity.chainSlug,
      checked: 0,
      confirmed: 0,
      reorged: 0,
      unknown: 0,
      reorgedObservations: [],
    };

    let newCursor: bigint | null = null;
    let stoppedOnUnknown = false;

    for (const group of groups) {
      let groupHasUnknown = false;

      for (const candidate of group.items) {
        // Captures the underlying failure message for logging without
        // changing checkBlockHashStillCanonical's own contract or behavior
        // at all - it still receives and reacts to the same throw exactly
        // as Phase 4 built it (reorg.ts is not modified by this task).
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
          logger.info("reorg recheck: observation still canonical", {
            component: "onchain-reorg-recheck",
            entityType: entity.entityType,
            entityKey: entity.configKey,
            chain: entity.chainSlug,
            blockNumber: candidate.blockNumber.toString(),
          });
          continue;
        }

        if (check.status === "reorged") {
          result.reorged++;
          // Excludes this row from canonical history (getPoolTvlHistory/
          // getPoolObservationCount, queries/pools.ts) and from future
          // recheck candidates (getObservationsNeedingRecheck already
          // filters on this) - without touching or deleting the row itself.
          // A throw here is caught by this function's own outer try/catch,
          // same as any other failure in this loop.
          await markObservationReorged(candidate.id, new Date());
          result.reorgedObservations.push({
            observationId: candidate.id,
            blockNumber: candidate.blockNumber.toString(),
            storedBlockHash: candidate.blockHash,
            currentBlockHash: check.currentBlockHash,
          });
          logger.warn("reorg recheck: observation no longer canonical - chain reorged past this block", {
            component: "onchain-reorg-recheck",
            entityType: entity.entityType,
            entityKey: entity.configKey,
            chain: entity.chainSlug,
            blockNumber: candidate.blockNumber.toString(),
            storedBlockHash: candidate.blockHash,
            currentBlockHash: check.currentBlockHash,
          });
          continue;
        }

        // "unknown" - never treated as confirmed or reorged (see
        // checkBlockHashStillCanonical). Marks this whole group unresolved;
        // the outer loop below stops before advancing the cursor past it.
        result.unknown++;
        logger.warn("reorg recheck: inconclusive - could not read current block hash", {
          component: "onchain-reorg-recheck",
          entityType: entity.entityType,
          entityKey: entity.configKey,
          chain: entity.chainSlug,
          blockNumber: candidate.blockNumber.toString(),
          error: readError,
        });
        groupHasUnknown = true;
      }

      if (groupHasUnknown) {
        stoppedOnUnknown = true;
        break;
      }
      // Every observation sharing this block number resolved (confirmed or
      // reorged, never unknown) - safe to advance the cursor to it.
      newCursor = group.blockNumber;
    }

    const hadReorg = result.reorged > 0;
    // Only a genuinely, fully successful pass - every candidate group
    // resolved, nothing reorged - counts as "last successful sync." A
    // reorg or an inconclusive RPC read means this run did not cleanly
    // complete, and must never be recorded as if it had.
    const succeeded = !stoppedOnUnknown && !hadReorg;
    await updateIndexingState(entity.chainSlug, component, {
      status: succeeded ? "idle" : "error",
      error: hadReorg
        ? `reorg detected in ${result.reorged} observation(s) - see sync_runs/logs for this run`
        : stoppedOnUnknown
          ? "RPC read failed while rechecking - will retry next run"
          : null,
      ...(succeeded ? { lastSuccessfulSyncAt: new Date() } : {}),
      ...(newCursor != null ? { lastProcessedBlock: newCursor } : {}),
    });

    return result;
  } catch (err) {
    // An unexpected failure anywhere in the try above - including before
    // the "running" update ever ran (e.g. getObservationsNeedingRecheck
    // itself throwing) - must not leave this entity's indexingState stuck
    // at "running" forever, AND must still record that an attempt happened.
    // lastAttemptedSyncAt is written here unconditionally (not just status/
    // error, which is all this used to set) specifically so a failure this
    // early doesn't leave the entity looking never-attempted: runRecheck's
    // least-recently-attempted ordering would otherwise keep selecting the
    // same failing entity first on every run, starving every entity behind
    // it. This never overwrites a *successful-completion* signal -
    // lastSuccessfulSyncAt is untouched here, only lastAttemptedSyncAt (an
    // attempt was made, whether or not it succeeded) - so this can't be
    // confused with the run having actually completed.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await updateIndexingState(entity.chainSlug, component, {
        status: "error",
        error: message,
        lastAttemptedSyncAt: new Date(),
      });
    } catch {
      // Best-effort - a secondary DB failure here must never mask the
      // original error being rethrown below.
    }
    throw err;
  }
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
  const lockConn = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: LOCK_CONNECTION_TIMEOUT_SECONDS,
    idle_timeout: LOCK_IDLE_TIMEOUT_SECONDS,
  });
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

    // Pool, vault, and token-price entities are gathered independently (they
    // live in different tables/derivations - see
    // getVerifiedPoolEntities/getVerifiedVaultEntities/
    // getVerifiedTokenPriceEntities, queries/onchain-recheck.ts) but merged
    // into one RecheckEntity[] before anything else runs, so batching,
    // rotation, and chain filtering all apply uniformly across all three
    // kinds from this point on.
    //
    // Supplying *any one* override puts this run in fully manual/test mode:
    // every other kind defaults to an empty list, never a live query, so a
    // test that only overrides pools can never have real production vaults
    // or token prices (or vice versa) silently mixed into its entity set and
    // counts. Only when NONE of the three overrides is supplied does this
    // fall through to real production behavior (all three real queries).
    const usingAnyOverride =
      options.poolEntitiesOverride !== undefined ||
      options.vaultEntitiesOverride !== undefined ||
      options.tokenEntitiesOverride !== undefined;
    const poolEntities: RecheckEntity[] = options.poolEntitiesOverride
      ? options.poolEntitiesOverride.map((e) => ({
          entityType: "pool" as const,
          entityId: e.poolId,
          configKey: e.configKey,
          chainSlug: e.chainSlug,
          metric: "tvl_usd",
        }))
      : usingAnyOverride
        ? []
        : await getVerifiedPoolEntities();
    const vaultEntities: RecheckEntity[] = options.vaultEntitiesOverride
      ? options.vaultEntitiesOverride.map((e) => ({
          entityType: "vault" as const,
          entityId: e.vaultId,
          configKey: e.configKey,
          chainSlug: e.chainSlug,
          metric: "tvl_usd",
        }))
      : usingAnyOverride
        ? []
        : await getVerifiedVaultEntities();
    const tokenEntities: RecheckEntity[] = options.tokenEntitiesOverride
      ? options.tokenEntitiesOverride.map((e) => ({
          entityType: "token" as const,
          entityId: e.tokenId,
          configKey: e.configKey,
          chainSlug: e.chainSlug,
          metric: "price_usd",
        }))
      : usingAnyOverride
        ? []
        : await getVerifiedTokenPriceEntities();
    let entities: RecheckEntity[] = [...poolEntities, ...vaultEntities, ...tokenEntities];
    if (options.chainSlugs) {
      const allowed = new Set(options.chainSlugs);
      entities = entities.filter((e) => allowed.has(e.chainSlug));
    }

    // Ordered least-recently-attempted first, using indexingState's own
    // persisted lastAttemptedSyncAt (never-attempted entities sort first,
    // via the ?? 0 fallback) - not an in-memory rotation, so this stays
    // correct across process restarts and serverless cold starts. Without
    // this, a fixed entity order combined with a batchSize smaller than the
    // entity count would always process the same leading entities every
    // run and starve the rest indefinitely. A small extra read per entity
    // (recheckOneEntity below re-reads the same row) - an acceptable cost
    // at this app's real entity count (currently 8: 6 pools + 2 vaults).
    const withLastAttempt = await Promise.all(
      entities.map(async (entity) => {
        const state = await getIndexingState(
          entity.chainSlug,
          `${RECHECK_COMPONENT_PREFIX}:${entity.entityType}:${entity.configKey}`,
        );
        return { entity, lastAttemptedAt: state?.lastAttemptedSyncAt?.getTime() ?? 0 };
      }),
    );
    withLastAttempt.sort((a, b) => a.lastAttemptedAt - b.lastAttemptedAt);
    entities = withLastAttempt.map((w) => w.entity);

    const stats: ReorgRecheckStats = {
      entitiesConsidered: entities.length,
      entitiesProcessed: 0,
      entitiesSkippedBatchLimit: 0,
      entitiesFailed: 0,
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

      let result: ReorgRecheckEntityResult | null;
      try {
        result = await recheckOneEntity(entity, lookbackDepth, readBlockHash);
      } catch (err) {
        // One entity's failure must never abort the run for the rest -
        // recheckOneEntity has already recorded the failure into this
        // entity's own indexingState row (see its own catch block); this
        // records it into this run's own stats/perEntity and moves on to
        // the next entity.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("reorg recheck: entity failed - continuing with remaining entities", {
          component: "onchain-reorg-recheck",
          entityType: entity.entityType,
          entityKey: entity.configKey,
          chain: entity.chainSlug,
          error: message,
        });
        stats.entitiesProcessed++;
        stats.entitiesFailed++;
        stats.perEntity.push({
          entityType: entity.entityType,
          entityKey: entity.configKey,
          chainSlug: entity.chainSlug,
          checked: 0,
          confirmed: 0,
          reorged: 0,
          unknown: 0,
          reorgedObservations: [],
          error: message,
        });
        continue;
      }

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
    // The unlock is isolated in its own try so that if it throws (e.g. the
    // connection already dropped), lockConn.end() below still always runs -
    // a leaked connection would otherwise be possible if unlock itself
    // failed before reaching end(). Postgres also releases a session-scoped
    // advisory lock automatically on disconnect, so a failed unlock here
    // still can't leave the lock permanently stuck even in that case.
    try {
      if (locked) {
        await lockConn`select pg_advisory_unlock(${REORG_RECHECK_ADVISORY_LOCK_KEY})`;
      }
    } finally {
      await lockConn.end();
    }
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
        errorCount: stats.totalReorged + stats.totalUnknown + stats.entitiesFailed,
        metadata: {
          entitiesConsidered: stats.entitiesConsidered,
          entitiesProcessed: stats.entitiesProcessed,
          entitiesSkippedBatchLimit: stats.entitiesSkippedBatchLimit,
          entitiesFailed: stats.entitiesFailed,
          totalConfirmed: stats.totalConfirmed,
          totalReorged: stats.totalReorged,
          totalUnknown: stats.totalUnknown,
          reorgedObservations: stats.perEntity.flatMap((e) =>
            e.reorgedObservations.map((o) => ({ entityType: e.entityType, entityKey: e.entityKey, chain: e.chainSlug, ...o })),
          ),
        },
      },
      // "partial" whenever anything is reorged, inconclusive, or an entity
      // outright failed - lets the health view distinguish "every
      // rechecked observation is still canonical" from "something needs
      // attention," matching workers/onchain/verify.ts's own
      // success-vs-partial convention.
      outcome:
        stats.totalReorged + stats.totalUnknown + stats.entitiesFailed > 0 ? ("partial" as const) : ("success" as const),
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
