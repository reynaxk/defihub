// Real-Postgres integration test, same reasoning as
// lib/security/rate-limit.test.ts: whether a thrown worker error still
// leaves a correctly-finished sync_runs row is the actual thing under
// test, not something worth mocking the DB write for.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { syncRuns } from "@/lib/database/schema";
import { withSyncRun } from "./sync-run";

describe("withSyncRun", () => {
  const createdRunIds: string[] = [];

  afterEach(async () => {
    for (const id of createdRunIds.splice(0)) await db.delete(syncRuns).where(eq(syncRuns.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function rowFor(worker: string) {
    const rows = await db.select().from(syncRuns).where(eq(syncRuns.worker, worker));
    createdRunIds.push(...rows.map((r) => r.id));
    return rows;
  }

  it("records a success run with the reported stats", async () => {
    const worker = `test-worker-${randomUUID()}`;
    const result = await withSyncRun(worker, async () => ({
      result: 42,
      stats: { recordsProcessed: 10, recordsCreated: 5 },
    }));
    expect(result).toBe(42);

    const [row] = await rowFor(worker);
    expect(row.status).toBe("success");
    expect(row.recordsProcessed).toBe(10);
    expect(row.recordsCreated).toBe(5);
    expect(row.finishedAt).not.toBeNull();
    expect(row.durationMs).not.toBeNull();
  });

  it("still finishes the row as failed, with the error message, when fn throws", async () => {
    const worker = `test-worker-${randomUUID()}`;
    await expect(
      withSyncRun(worker, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [row] = await rowFor(worker);
    expect(row.status).toBe("failed");
    expect(row.errorSummary).toBe("boom");
    expect(row.finishedAt).not.toBeNull();
  });

  it("records a partial outcome when fn reports one explicitly", async () => {
    const worker = `test-worker-${randomUUID()}`;
    await withSyncRun(worker, async () => ({
      result: null,
      stats: { recordsProcessed: 3, errorCount: 1, errorSummary: "1 of 4 chains failed" },
      outcome: "partial" as const,
    }));

    const [row] = await rowFor(worker);
    expect(row.status).toBe("partial");
    expect(row.errorCount).toBe(1);
  });

  it("gives two concurrent runs of the same worker their own independent rows", async () => {
    const worker = `test-worker-${randomUUID()}`;
    await Promise.all([withSyncRun(worker, async () => ({ result: 1 })), withSyncRun(worker, async () => ({ result: 2 }))]);

    const rows = await rowFor(worker);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "success")).toBe(true);
  });
});
