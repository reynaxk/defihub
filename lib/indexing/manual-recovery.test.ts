// Real-Postgres integration test for manuallyAdvanceCursor - the
// atomic-upsert path it goes through (updateIndexingState) is the same
// real thing under test as lib/indexing/state.test.ts.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { indexingState } from "@/lib/database/schema";
import { getIndexingState, updateIndexingState } from "./state";
import { manuallyAdvanceCursor } from "./manual-recovery";

describe("manuallyAdvanceCursor", () => {
  const createdKeys: { chainSlug: string; component: string }[] = [];

  afterEach(async () => {
    for (const { chainSlug, component } of createdKeys.splice(0)) {
      await db.delete(indexingState).where(and(eq(indexingState.chainSlug, chainSlug), eq(indexingState.component, component)));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("advances a stuck cursor to the requested block and records why", async () => {
    const component = `test-recovery-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });
    await updateIndexingState("ethereum", component, { status: "error", lastProcessedBlock: BigInt(1000) });

    const result = await manuallyAdvanceCursor("ethereum", component, BigInt(5000), "provider window permanently unreachable at this depth");

    expect(result).toEqual({ previousCursor: BigInt(1000), newCursor: BigInt(5000) });
    const row = await getIndexingState("ethereum", component);
    expect(row?.lastProcessedBlock).toBe(BigInt(5000));
    expect(row?.status).toBe("idle");
    expect(row?.error).toContain("provider window permanently unreachable");
    expect(row?.error).toContain("1001-5000"); // the exact skipped range, never hidden
  });

  it("works from a genuinely fresh (never-indexed) component too", async () => {
    const component = `test-recovery-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    const result = await manuallyAdvanceCursor("ethereum", component, BigInt(2000), "operator-initiated cold start past an unreachable historical range");

    expect(result.previousCursor).toBeNull();
    expect(result.newCursor).toBe(BigInt(2000));
  });

  it("refuses to move the cursor backward (Invariant 3 applies to manual recovery too)", async () => {
    const component = `test-recovery-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });
    await updateIndexingState("ethereum", component, { lastProcessedBlock: BigInt(5000) });

    await expect(manuallyAdvanceCursor("ethereum", component, BigInt(1000), "accidental operator mistake")).rejects.toThrow(/refusing to move/);

    const row = await getIndexingState("ethereum", component);
    expect(row?.lastProcessedBlock).toBe(BigInt(5000)); // unchanged
  });

  it("refuses to advance to the exact same block (a no-op that would still fabricate a misleading 'skipped' log entry)", async () => {
    const component = `test-recovery-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });
    await updateIndexingState("ethereum", component, { lastProcessedBlock: BigInt(5000) });

    await expect(manuallyAdvanceCursor("ethereum", component, BigInt(5000), "no-op")).rejects.toThrow(/refusing to move/);
  });

  it("requires a real, non-empty reason - never a silent skip", async () => {
    const component = `test-recovery-${randomUUID()}`;
    createdKeys.push({ chainSlug: "ethereum", component });

    await expect(manuallyAdvanceCursor("ethereum", component, BigInt(1000), "")).rejects.toThrow(/reason is required/);
    await expect(manuallyAdvanceCursor("ethereum", component, BigInt(1000), "   ")).rejects.toThrow(/reason is required/);
  });
});
