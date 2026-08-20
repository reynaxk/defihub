import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { syncRuns } from "@/lib/database/schema";
import { logger } from "./logger";

export interface SyncRunStats {
  recordsProcessed?: number;
  recordsCreated?: number;
  recordsUpdated?: number;
  errorCount?: number;
  errorSummary?: string;
  metadata?: Record<string, unknown>;
}

export type SyncRunOutcome = "success" | "partial" | "failed";

// Wraps a worker invocation with a sync_runs row: inserted at start
// (status "running"), updated to its final status once `fn` settles -
// always, even on throw, so a crashed worker leaves a "failed" row rather
// than one stuck at "running" forever. `fn` reports its own stats/outcome
// (most workers already compute a count worth logging); a thrown error is
// itself treated as "failed" with the error's message as the summary.
//
// Tracking is best-effort throughout: every read/write against sync_runs
// is wrapped in its own try/catch and only ever logged, never thrown -
// observability must not become a reason a real sync fails (same
// philosophy as lib/security/rate-limit.ts's best-effort bucket cleanup).
export async function withSyncRun<T>(
  worker: string,
  fn: () => Promise<{ result: T; stats?: SyncRunStats; outcome?: SyncRunOutcome }>,
): Promise<T> {
  const startedAt = new Date();
  const runId = await tryStart(worker, startedAt);

  try {
    const { result, stats, outcome = "success" } = await fn();
    await finish(runId, worker, startedAt, outcome, stats);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(runId, worker, startedAt, "failed", { errorCount: 1, errorSummary: message });
    throw err;
  }
}

async function tryStart(worker: string, startedAt: Date): Promise<string | null> {
  try {
    const [row] = await db
      .insert(syncRuns)
      .values({ worker, status: "running", startedAt })
      .returning({ id: syncRuns.id });
    return row?.id ?? null;
  } catch (err) {
    logger.warn("failed to record sync_runs start", { component: "sync-run", operation: worker, error: err });
    return null;
  }
}

async function finish(
  runId: string | null,
  worker: string,
  startedAt: Date,
  outcome: SyncRunOutcome,
  stats?: SyncRunStats,
): Promise<void> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  if (runId) {
    try {
      await db
        .update(syncRuns)
        .set({
          status: outcome,
          finishedAt,
          durationMs,
          recordsProcessed: stats?.recordsProcessed,
          recordsCreated: stats?.recordsCreated,
          recordsUpdated: stats?.recordsUpdated,
          errorCount: stats?.errorCount ?? 0,
          errorSummary: stats?.errorSummary,
          metadata: stats?.metadata,
        })
        .where(eq(syncRuns.id, runId));
    } catch (err) {
      logger.warn("failed to record sync_runs finish", { component: "sync-run", operation: worker, error: err });
    }
  }

  const log = outcome === "failed" ? logger.error : outcome === "partial" ? logger.warn : logger.info;
  log(`${worker} ${outcome}`, { component: "sync-run", operation: worker, durationMs, ...stats });
}
