import "dotenv/config";
import postgres from "postgres";
import { closeDb } from "../../lib/database/client";
import { getAllVolumeSourcePools } from "../../lib/onchain/discovery/volume-source";
import { indexAllPoolVolume, type PoolVolumeRunResult } from "../../lib/onchain/volume/engine";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export interface VolumeRunSummary {
  succeeded: number;
  partial: number;
  failed: number;
  totalSwaps: number;
  outcome: "success" | "partial" | "failed";
}

// Pure - turns per-pool results into the run's overall stats and
// success/partial/failed classification (Section 26), directly
// unit-testable with plain constructed inputs (see volume.test.ts).
// "success" requires every pool to have fully caught up to its safe head
// this run; "partial" covers both a pool that made real but incomplete
// catch-up progress AND a run where some pools succeeded while others
// failed outright (Section 30/31's multi-chain/multi-pool isolation: one
// broken pool must not make the whole run report as a flat failure when
// other pools genuinely progressed); "failed" is reserved for a run where
// NOTHING succeeded anywhere.
export function summarizeVolumeResults(results: PoolVolumeRunResult[]): VolumeRunSummary {
  let succeeded = 0;
  let partial = 0;
  let failed = 0;
  let totalSwaps = 0;

  for (const r of results) {
    if (r.outcome === "success") succeeded++;
    else if (r.outcome === "partial") partial++;
    else failed++;
    totalSwaps += r.chunks.reduce((sum, c) => sum + c.swapCount, 0);
  }

  const anyProgress = succeeded > 0 || partial > 0;
  const outcome: VolumeRunSummary["outcome"] = failed === 0 ? (partial > 0 ? "partial" : "success") : anyProgress ? "partial" : "failed";

  return { succeeded, partial, failed, totalSwaps, outcome };
}

// Distinct from recheck-reorgs.ts's REORG_RECHECK_ADVISORY_LOCK_KEY
// (851902733), volume/reorg.ts's VOLUME_REORG_RECHECK_ADVISORY_LOCK_KEY
// (402917588), and rollup.ts's ROLLUP_ADVISORY_LOCK_KEY (728140501) -
// every advisory-lock user in this app must use a unique key. Phase 5.5:
// a catch-up run can now legitimately take much longer than a single
// small scan (many chunks in one call - see lib/indexing/events.ts), which
// raises the odds of a cron invocation firing while the previous one is
// still mid-run (Section 27/28's "concurrent run protection"). Guards the
// whole indexing pass, not per-pool - two overlapping invocations racing
// to advance the SAME pool's cursor is the actual risk (Invariant 3); the
// existing GREATEST-protected atomic checkpoint upsert (lib/indexing/
// state.ts) is already a second, independent layer of protection even if
// this lock were somehow bypassed.
export const VOLUME_INDEX_ADVISORY_LOCK_KEY = 619284037;

const LOCK_CONNECTION_TIMEOUT_SECONDS = 10;
// A catch-up run can span many chunks/minutes - this lock-holder
// connection must outlive the whole indexing pass, unlike the reorg-
// recheck jobs' shorter-lived 90s idle_timeout. maxDuration on the cron
// route itself remains the hard outer bound.
const LOCK_IDLE_TIMEOUT_SECONDS = 300;

function summarizePoolChunks(result: PoolVolumeRunResult) {
  return result.chunks.reduce(
    (acc, c) => ({
      swapCount: acc.swapCount + c.swapCount,
      pricedSwapCount: acc.pricedSwapCount + c.pricedSwapCount,
      unpricedSwapCount: acc.unpricedSwapCount + c.unpricedSwapCount,
    }),
    { swapCount: 0, pricedSwapCount: 0, unpricedSwapCount: 0 },
  );
}

// Phase 5.9: indexes every config-curated pool PLUS every discovery-
// validated "active" pool - see lib/onchain/discovery/volume-source.ts's
// own comment for why this is the smallest safe bridge (indexAllPoolVolume
// itself stays entirely unaware discovery exists; it just receives a
// longer pool list built the same way as always).
async function runIndexOnchainVolume(): Promise<PoolVolumeRunResult[]> {
  const pools = await getAllVolumeSourcePools();
  const results = await indexAllPoolVolume(pools);

  for (const r of results) {
    const totals = summarizePoolChunks(r);
    if (r.outcome === "success") {
      logger.info("volume indexed", {
        component: "onchain-volume",
        pool: r.poolKey,
        outcome: r.outcome,
        chunksCompleted: r.chunksCompleted,
        ...totals,
        lag: r.lag,
      });
    } else if (r.outcome === "partial") {
      // Section 25: a partial run must never be logged/reported as if it
      // were complete - chunksCompleted/lag make the real, incomplete
      // extent of this run's progress explicit.
      logger.warn("volume indexing: partial catch-up progress this run", {
        component: "onchain-volume",
        pool: r.poolKey,
        outcome: r.outcome,
        stoppedReason: r.stoppedReason,
        chunksCompleted: r.chunksCompleted,
        chunksAttempted: r.chunksAttempted,
        ...totals,
        safeHead: r.safeHead,
        cursorAfterRun: r.cursorAfterRun,
        lag: r.lag,
      });
    } else {
      logger.warn("volume indexing failed for pool", {
        component: "onchain-volume",
        pool: r.poolKey,
        reason: r.error,
        chunksCompletedBeforeFailure: r.chunksCompleted,
      });
    }
  }

  return results;
}

// Phase 5.4's native volume/fees/revenue indexer, run as its own worker -
// same withSyncRun/logger pattern as price.ts, its own "onchain-volume"
// sync_runs name so a failure here is independently visible in
// /api/cron/health rather than blurred into price.ts's or verify.ts's own
// success rate. Phase 5.5 adds a session-scoped advisory lock around the
// whole indexing pass - see VOLUME_INDEX_ADVISORY_LOCK_KEY's own comment.
//
// Phase 5.8 fix: withSyncRun (lib/observability/sync-run.ts) only re-throws
// when its own callback throws - a callback that instead RETURNS `outcome:
// "failed"` (summarizeVolumeResults's own genuine "nothing succeeded
// anywhere" classification) resolves normally. Since this function's only
// caller (the /api/cron/index-volume route) does `await
// indexOnchainVolume(); return NextResponse.json({ ok: true })` with no
// outcome inspection of its own, a run where EVERY pool failed used to
// still return HTTP 200 - invisible to Vercel's own cron-failure detection
// and any external monitoring keyed off HTTP status, even though
// sync_runs.status was already being correctly recorded as "failed" the
// whole time. `outcome` is now captured from inside the withSyncRun
// callback (via a closure, not by changing withSyncRun's own shared
// contract, which every other worker also depends on) and explicitly
// re-thrown as an Error once withSyncRun itself has already finished
// recording the (unchanged, already-correct) sync_runs row - the cron
// route's existing try/catch then does the right thing with zero route-level
// changes needed. "partial" (including the lock-contention skip) and
// "success" are unaffected - only a genuine total failure now propagates.
export async function indexOnchainVolume(): Promise<void> {
  // A mutable object, not a plain `let` - TypeScript's control-flow
  // narrowing treats a `let` reassigned only inside a closure as if it
  // were never reassigned by the time control returns here (it can't see
  // across the withSyncRun callback boundary), which would falsely narrow
  // `outcome` to its initial literal and reject the `=== "failed"` check
  // below as unreachable. A property on a plain object isn't narrowed the
  // same way, so this reads its real, post-callback value correctly.
  const run: { outcome: VolumeRunSummary["outcome"] | "skipped"; failureDetail: string } = { outcome: "skipped", failureDetail: "" };

  await withSyncRun("onchain-volume", async () => {
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
      const [{ locked: acquired }] = await lockConn`select pg_try_advisory_lock(${VOLUME_INDEX_ADVISORY_LOCK_KEY}) as locked`;
      locked = acquired;
      if (!locked) {
        logger.warn("volume indexing already in progress in another invocation, skipping this run", { component: "onchain-volume" });
        return { result: undefined, stats: { recordsProcessed: 0, metadata: { skipped: "already running elsewhere" } }, outcome: "partial" as const };
      }

      const results = await runIndexOnchainVolume();
      const summary = summarizeVolumeResults(results);
      run.outcome = summary.outcome;
      if (summary.outcome === "failed") {
        run.failureDetail = results.map((r) => `${r.poolKey}: ${r.error ?? "unknown error"}`).join("; ");
      }

      return {
        result: undefined,
        stats: {
          recordsProcessed: summary.totalSwaps,
          errorCount: summary.failed,
          metadata: { succeeded: summary.succeeded, partial: summary.partial, failed: summary.failed, poolsConsidered: results.length },
        },
        outcome: summary.outcome,
      };
    } finally {
      try {
        if (locked) await lockConn`select pg_advisory_unlock(${VOLUME_INDEX_ADVISORY_LOCK_KEY})`;
      } finally {
        await lockConn.end();
      }
    }
  });

  if (run.outcome === "failed") {
    throw new Error(`onchain-volume indexing failed - every configured pool failed this run: ${run.failureDetail}`);
  }
}

if (require.main === module) {
  indexOnchainVolume()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("volume indexing failed", { component: "onchain-volume", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
