import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { syncRuns } from "@/lib/database/schema";

export interface SyncHealthSummary {
  worker: string;
  currentlyRunning: boolean;
  lastSuccess: {
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    recordsProcessed: number | null;
  } | null;
  lastFailure: {
    startedAt: Date;
    finishedAt: Date | null;
    errorSummary: string | null;
  } | null;
}

// Every worker that writes sync_runs rows (see withSyncRun, called from
// each worker's cron route) - kept as an explicit list rather than
// discovered from the table, so a worker with zero runs yet still shows up
// as "no data" instead of silently not appearing at all.
const KNOWN_WORKERS = [
  "chains",
  "protocols",
  "tokens",
  "prices",
  "yields",
  "alerts",
  "onchain",
  "rollup-metrics",
];

// Answers "is my protocol sync actually working" without reading raw
// platform logs - last successful run, last failure, and whether a run is
// in flight right now, per worker.
export async function getLatestSyncStatus(worker?: string): Promise<SyncHealthSummary[]> {
  const workers = worker ? [worker] : KNOWN_WORKERS;
  return Promise.all(workers.map(getWorkerStatus));
}

async function getWorkerStatus(worker: string): Promise<SyncHealthSummary> {
  const [mostRecent, lastSuccessRow, lastFailureRow] = await Promise.all([
    db.select().from(syncRuns).where(eq(syncRuns.worker, worker)).orderBy(desc(syncRuns.startedAt)).limit(1),
    db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.worker, worker), eq(syncRuns.status, "success")))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1),
    db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.worker, worker), eq(syncRuns.status, "failed")))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1),
  ]);

  const lastSuccess = lastSuccessRow[0];
  const lastFailure = lastFailureRow[0];

  return {
    worker,
    currentlyRunning: mostRecent[0]?.status === "running",
    lastSuccess: lastSuccess
      ? {
          startedAt: lastSuccess.startedAt,
          finishedAt: lastSuccess.finishedAt,
          durationMs: lastSuccess.durationMs,
          recordsProcessed: lastSuccess.recordsProcessed,
        }
      : null,
    lastFailure: lastFailure
      ? {
          startedAt: lastFailure.startedAt,
          finishedAt: lastFailure.finishedAt,
          errorSummary: lastFailure.errorSummary,
        }
      : null,
  };
}
