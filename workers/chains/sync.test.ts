// Real-Postgres integration test, same reasoning as workers/retention/rollup.test.ts:
// the actual thing under test is what lands in chain_metrics + sync_runs, not
// mockable behavior. Only the external DefiLlama call is mocked.
import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chainMetrics, chains, syncRuns } from "@/lib/database/schema";

const mockGetChainTvlHistory = vi.fn();
vi.mock("../../lib/providers", () => ({
  defiDataProvider: { getChainTvlHistory: (...args: unknown[]) => mockGetChainTvlHistory(...args) },
}));

const { syncChains } = await import("./sync");

async function makeChain(defillamaSlug: string) {
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test ${defillamaSlug}`, slug: `test-${randomUUID()}`, nativeToken: "TST", defillamaSlug })
    .returning({ id: chains.id });
  return chain.id;
}

describe("syncChains", () => {
  const createdChainIds: string[] = [];

  beforeEach(() => {
    mockGetChainTvlHistory.mockReset();
  });

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) {
      await db.delete(chainMetrics).where(eq(chainMetrics.chainId, id));
      await db.delete(chains).where(eq(chains.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("continues syncing remaining chains when one chain's history fetch fails, and reports a partial run", async () => {
    const failingSlug = `failing-${randomUUID()}`;
    const okSlug = `ok-${randomUUID()}`;
    const failingChainId = await makeChain(failingSlug);
    const okChainId = await makeChain(okSlug);
    createdChainIds.push(failingChainId, okChainId);

    mockGetChainTvlHistory.mockImplementation(async (slug: string) => {
      if (slug === failingSlug) throw new Error("DefiLlama 500 for this chain");
      if (slug === okSlug) return [{ timestamp: new Date(), tvl: 12345 }];
      return [];
    });

    await syncChains();

    // The failing chain didn't block the healthy one.
    expect(mockGetChainTvlHistory).toHaveBeenCalledWith(failingSlug);
    expect(mockGetChainTvlHistory).toHaveBeenCalledWith(okSlug);
    const okRows = await db.select().from(chainMetrics).where(eq(chainMetrics.chainId, okChainId));
    expect(okRows).toHaveLength(1);

    const [run] = await db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.worker, "chains"))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    expect(run.status).toBe("partial");
    expect(run.errorCount).toBe(1);
  });
});
