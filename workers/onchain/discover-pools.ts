import "dotenv/config";
import postgres from "postgres";
import { closeDb } from "../../lib/database/client";
import { discoverAllPools, type DiscoveryRunResult } from "../../lib/onchain/discovery/engine";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export interface DiscoveryRunSummary {
  succeeded: number;
  failed: number;
  totalDiscovered: number;
  totalActivated: number;
  totalRejected: number;
  outcome: "success" | "partial" | "failed";
}

// Pure - mirrors summarizeVolumeResults (workers/onchain/volume.ts) exactly:
// "success" means every deployment's scan completed without error,
// "failed" means nothing succeeded anywhere, "partial" covers everything
// in between (one deployment failed while another progressed, or a
// deployment's own scan itself only made partial catch-up progress this
// run).
export function summarizeDiscoveryResults(results: DiscoveryRunResult[]): DiscoveryRunSummary {
  let succeeded = 0;
  let failed = 0;
  let totalDiscovered = 0;
  let totalActivated = 0;
  let totalRejected = 0;

  for (const r of results) {
    if (r.ok) succeeded++;
    else failed++;
    totalDiscovered += r.discovered;
    totalActivated += r.activated;
    totalRejected += r.rejected;
  }

  const anyPartialScan = results.some((r) => r.ok && r.scanOutcome === "partial");
  const anyProgress = succeeded > 0;
  const outcome: DiscoveryRunSummary["outcome"] = failed === 0 ? (anyPartialScan ? "partial" : "success") : anyProgress ? "partial" : "failed";

  return { succeeded, failed, totalDiscovered, totalActivated, totalRejected, outcome };
}

// Distinct from every other advisory-lock user in this app
// (VOLUME_INDEX_ADVISORY_LOCK_KEY 619284037, VOLUME_REORG_RECHECK_ADVISORY_LOCK_KEY
// 402917588, REORG_RECHECK_ADVISORY_LOCK_KEY 851902733,
// ROLLUP_ADVISORY_LOCK_KEY 728140501) - every advisory-lock user in this app
// must use a unique key. Guards the whole discovery pass (scan + validate
// across every deployment), not per-deployment - two overlapping
// invocations racing to advance the SAME deployment's discovery cursor is
// the actual risk, the same reasoning VOLUME_INDEX_ADVISORY_LOCK_KEY's own
// comment already documents; the existing GREATEST-protected atomic
// checkpoint upsert (lib/indexing/state.ts) is already a second,
// independent layer of protection even if this lock were somehow bypassed.
export const DISCOVER_POOLS_ADVISORY_LOCK_KEY = 583920174;

const LOCK_CONNECTION_TIMEOUT_SECONDS = 10;
const LOCK_IDLE_TIMEOUT_SECONDS = 300;

async function runDiscoverPools(): Promise<DiscoveryRunResult[]> {
  const results = await discoverAllPools();

  for (const r of results) {
    if (r.ok) {
      logger.info("pool discovery run", {
        component: "onchain-discovery",
        deployment: r.deploymentKey,
        discovered: r.discovered,
        activated: r.activated,
        rejected: r.rejected,
        scanOutcome: r.scanOutcome,
        chunksCompleted: r.chunksCompleted,
      });
    } else {
      logger.warn("pool discovery failed for deployment", { component: "onchain-discovery", deployment: r.deploymentKey, reason: r.error });
    }
  }

  return results;
}

// Phase 5.9's factory-based pool discovery indexer, run as its own worker -
// same withSyncRun/advisory-lock/throw-on-total-failure pattern
// workers/onchain/volume.ts already established (see that file's own Phase
// 5.8 comment for exactly why a total failure must propagate as a thrown
// error rather than resolving normally under a misleading HTTP 200).
export async function discoverOnchainPools(): Promise<void> {
  const run: { outcome: DiscoveryRunSummary["outcome"] | "skipped"; failureDetail: string } = { outcome: "skipped", failureDetail: "" };

  await withSyncRun("onchain-discovery", async () => {
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
      const [{ locked: acquired }] = await lockConn`select pg_try_advisory_lock(${DISCOVER_POOLS_ADVISORY_LOCK_KEY}) as locked`;
      locked = acquired;
      if (!locked) {
        logger.warn("pool discovery already in progress in another invocation, skipping this run", { component: "onchain-discovery" });
        return { result: undefined, stats: { recordsProcessed: 0, metadata: { skipped: "already running elsewhere" } }, outcome: "partial" as const };
      }

      const results = await runDiscoverPools();
      const summary = summarizeDiscoveryResults(results);
      run.outcome = summary.outcome;
      if (summary.outcome === "failed") {
        run.failureDetail = results.map((r) => `${r.deploymentKey}: ${r.error ?? "unknown error"}`).join("; ");
      }

      return {
        result: undefined,
        stats: {
          recordsProcessed: summary.totalDiscovered,
          errorCount: summary.failed,
          metadata: { succeeded: summary.succeeded, failed: summary.failed, totalDiscovered: summary.totalDiscovered, totalActivated: summary.totalActivated, totalRejected: summary.totalRejected },
        },
        outcome: summary.outcome,
      };
    } finally {
      try {
        if (locked) await lockConn`select pg_advisory_unlock(${DISCOVER_POOLS_ADVISORY_LOCK_KEY})`;
      } finally {
        await lockConn.end();
      }
    }
  });

  if (run.outcome === "failed") {
    throw new Error(`onchain-discovery failed - every configured deployment failed this run: ${run.failureDetail}`);
  }
}

if (require.main === module) {
  discoverOnchainPools()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("pool discovery failed", { component: "onchain-discovery", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
