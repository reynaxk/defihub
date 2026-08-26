// Real-Postgres integration test, same reasoning as
// lib/security/rate-limit.test.ts: the atomic-upsert concurrency guarantee
// is the actual thing under test, not mockable behavior.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { indexingState } from "@/lib/database/schema";
import { getIndexingState, updateIndexingState } from "./state";

describe("indexing state", () => {
  const createdKeys: { chainSlug: string; component: string }[] = [];

  afterEach(async () => {
    for (const { chainSlug, component } of createdKeys.splice(0)) {
      await db
        .delete(indexingState)
        .where(and(eq(indexingState.chainSlug, chainSlug), eq(indexingState.component, component)));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns null for a key that has never been written", async () => {
    const result = await getIndexingState("ethereum", `test-${randomUUID()}`);
    expect(result).toBeNull();
  });

  it("creates a new row on first update and reads it back", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await updateIndexingState("ethereum", component, { status: "running", lastAttemptedSyncAt: new Date() });

    const row = await getIndexingState("ethereum", component);
    expect(row?.status).toBe("running");
    expect(row?.lastProcessedBlock).toBeNull();
  });

  it("updates an existing row in place rather than creating a duplicate", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await updateIndexingState("ethereum", component, { status: "running" });
    await updateIndexingState("ethereum", component, {
      status: "idle",
      lastProcessedBlock: BigInt(12345),
      lastSuccessfulSyncAt: new Date(),
    });

    const row = await getIndexingState("ethereum", component);
    expect(row?.status).toBe("idle");
    expect(row?.lastProcessedBlock).toBe(BigInt(12345));

    const allRows = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, "ethereum"), eq(indexingState.component, component)));
    expect(allRows).toHaveLength(1);
  });

  it("keeps chainSlug and component as independent keys", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component }, { chainSlug: "base", component });

    await updateIndexingState("ethereum", component, { lastProcessedBlock: BigInt(1) });
    await updateIndexingState("base", component, { lastProcessedBlock: BigInt(2) });

    const ethRow = await getIndexingState("ethereum", component);
    const baseRow = await getIndexingState("base", component);
    expect(ethRow?.lastProcessedBlock).toBe(BigInt(1));
    expect(baseRow?.lastProcessedBlock).toBe(BigInt(2));
  });

  it("resolves two concurrent upserts to the same key to exactly one row (restart/retry safety)", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await Promise.all([
      updateIndexingState("ethereum", component, { status: "running", lastProcessedBlock: BigInt(100) }),
      updateIndexingState("ethereum", component, { status: "running", lastProcessedBlock: BigInt(200) }),
    ]);

    const rows = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, "ethereum"), eq(indexingState.component, component)));
    expect(rows).toHaveLength(1);
    expect(["100", "200"]).toContain(rows[0].lastProcessedBlock);
  });

  // Section 29's exact scenario, deterministic (not racy) - worker B's
  // update (cursor 200) durably lands FIRST, then a stale worker A's
  // update (believing the cursor is still at an earlier position, cursor
  // 100) arrives SECOND. The atomic GREATEST(...) in updateIndexingState's
  // own onConflictDoUpdate must win over a plain last-write-wins upsert -
  // worker A's late, stale write must never move the cursor backward.
  it("never lets a stale worker's lower cursor value overwrite an already-advanced one (Invariant 3)", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await updateIndexingState("ethereum", component, { status: "idle", lastProcessedBlock: BigInt(200) });
    await updateIndexingState("ethereum", component, { status: "idle", lastProcessedBlock: BigInt(100) });

    const row = await getIndexingState("ethereum", component);
    expect(row?.lastProcessedBlock).toBe(BigInt(200));
  });

  it("still allows lastAttemptedSyncAt/status to update even when lastProcessedBlock is omitted, without touching the existing cursor", async () => {
    const component = `test-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await updateIndexingState("ethereum", component, { status: "idle", lastProcessedBlock: BigInt(500) });
    await updateIndexingState("ethereum", component, { status: "running", lastAttemptedSyncAt: new Date() });

    const row = await getIndexingState("ethereum", component);
    expect(row?.status).toBe("running");
    expect(row?.lastProcessedBlock).toBe(BigInt(500));
  });
});
