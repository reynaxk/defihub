// Real-Postgres integration test, same reasoning as lib/indexing/state.test.ts:
// the staleness derivation reads actual rows back through getLatestSyncStatus,
// not mockable behavior.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { syncRuns } from "@/lib/database/schema";
import { getLatestSyncStatus } from "./sync-health";

describe("sync health", () => {
  const createdWorkers: string[] = [];

  afterEach(async () => {
    for (const worker of createdWorkers.splice(0)) {
      await db.delete(syncRuns).where(eq(syncRuns.worker, worker));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reports a recent running row as currently running, not stalled", async () => {
    const worker = `test-${randomUUID()}`;
    createdWorkers.push(worker);
    await db.insert(syncRuns).values({ worker, status: "running", startedAt: new Date() });

    const [summary] = await getLatestSyncStatus(worker);
    expect(summary.currentlyRunning).toBe(true);
    expect(summary.stalledSince).toBeNull();
  });

  it("reports a running row older than the stale-run threshold as stalled, not running", async () => {
    const worker = `test-${randomUUID()}`;
    createdWorkers.push(worker);
    const startedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    await db.insert(syncRuns).values({ worker, status: "running", startedAt });

    const [summary] = await getLatestSyncStatus(worker);
    expect(summary.currentlyRunning).toBe(false);
    expect(summary.stalledSince).toEqual(startedAt);
  });

  it("reports no data for a worker with zero runs", async () => {
    const [summary] = await getLatestSyncStatus(`test-${randomUUID()}`);
    expect(summary.currentlyRunning).toBe(false);
    expect(summary.stalledSince).toBeNull();
    expect(summary.lastSuccess).toBeNull();
    expect(summary.lastFailure).toBeNull();
  });
});
