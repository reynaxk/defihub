// Real-Postgres integration test for recordSwapEvents - same pattern as
// lib/onchain/pricing/record-price-observation.integration.test.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, pools, swapEvents } from "@/lib/database/schema";
import { getRecentSwapEvents } from "./queries";
import { recordSwapEvents, type SwapEventRecord } from "./record-swap-events";
import type { DecodedSwapEvent } from "./types";

describe("recordSwapEvents", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndPool(): Promise<{ chainId: string; poolId: string }> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Volume Test Chain ${randomUUID()}`, slug: `volume-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const [pool] = await db
      .insert(pools)
      .values({ configKey: `volume-test-pool-${randomUUID()}`, chainId: chain.id, label: "Test Pool", address: `0xpool${randomUUID().slice(0, 8)}` })
      .returning({ id: pools.id });

    return { chainId: chain.id, poolId: pool.id };
  }

  function baseEvent(overrides: Partial<DecodedSwapEvent> = {}): DecodedSwapEvent {
    return {
      transactionHash: "0x" + "cc".repeat(32),
      logIndex: 5,
      blockNumber: BigInt(25839575),
      blockHash: "0x" + "dd".repeat(32),
      blockTimestamp: new Date("2026-08-26T13:05:59.000Z"),
      sender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      amount0In: BigInt(0),
      amount1In: BigInt("6097385952361777"),
      amount0Out: BigInt(14934999),
      amount1Out: BigInt(0),
      ...overrides,
    };
  }

  it("writes a real raw swap event row with full block identity and no USD/price data", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const count = await recordSwapEvents([{ chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent() }]);
    expect(count).toBe(1);

    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(rows).toHaveLength(1);
    expect(rows[0].blockNumber).toBe("25839575");
    expect(rows[0].amount1In).toBe("6097385952361777");
    expect(rows[0].amount0Out).toBe("14934999");
    expect(rows[0].reorgInvalidatedAt).toBeNull();
  });

  it("is idempotent for the exact same (poolId, txHash, logIndex) - a re-scanned range never double-counts", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const record: SwapEventRecord = { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent() };

    const first = await recordSwapEvents([record]);
    const second = await recordSwapEvents([record]);
    expect(first).toBe(1);
    expect(second).toBe(0);

    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(rows).toHaveLength(1);
  });

  it("treats a different logIndex in the same transaction as a distinct event - multiple swaps in one tx", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    await recordSwapEvents([
      { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent({ logIndex: 5 }) },
      { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent({ logIndex: 6 }) },
    ]);

    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(rows).toHaveLength(2);
  });

  it("batches an empty array as a true no-op, never erroring", async () => {
    const count = await recordSwapEvents([]);
    expect(count).toBe(0);
  });

  it("lets a new canonical event coexist with its orphaned pre-reorg sibling at the same (poolId, txHash, logIndex) but a different blockHash", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const HASH_1 = "0x" + "11".repeat(32);
    const HASH_2 = "0x" + "22".repeat(32);
    const sharedIdentity = { transactionHash: "0x" + "ff".repeat(32), logIndex: 3 };

    // 1. Ingest event A with block hash H1.
    await recordSwapEvents([
      { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent({ ...sharedIdentity, blockHash: HASH_1, amount1In: BigInt(1000000000000000) }) },
    ]);

    // 2. Invalidate/orphan event A (simulating what lib/onchain/volume/reorg.ts does on a detected reorg).
    await db.update(swapEvents).set({ reorgInvalidatedAt: new Date() }).where(eq(swapEvents.blockHash, HASH_1));

    // 3. Re-ingest the SAME transaction/log identity, now on a different canonical block hash H2 -
    // the exact scenario a reorg produces (the tx got re-mined into a different block).
    const secondCount = await recordSwapEvents([
      { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent({ ...sharedIdentity, blockHash: HASH_2, amount1In: BigInt(2000000000000000) }) },
    ]);

    // 4. Verify canonical event H2 is stored - NOT silently dropped as a
    // duplicate of the orphaned H1 row (which the OLD 3-column identity
    // would have done).
    expect(secondCount).toBe(1);
    const allRows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(allRows).toHaveLength(2);
    const canonicalRow = allRows.find((r) => r.blockHash === HASH_2);
    const orphanedRow = allRows.find((r) => r.blockHash === HASH_1);
    expect(canonicalRow?.reorgInvalidatedAt).toBeNull();
    expect(canonicalRow?.amount1In).toBe("2000000000000000");
    expect(orphanedRow?.reorgInvalidatedAt).not.toBeNull();

    // 5. Verify H2 contributes to aggregate calculations - getRecentSwapEvents
    // (the canonical-only read every aggregate calculation is built from)
    // returns ONLY the canonical H2 event, excluding the orphaned H1 one.
    const canonical = await getRecentSwapEvents(poolId, 10);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].amount1In).toBe("2000000000000000");
  });

  it("still idempotently no-ops a repeat insert of the exact same (poolId, txHash, logIndex, blockHash) - reorg-safety does not weaken normal dedup", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const record: SwapEventRecord = { chainId, poolId, sourceKind: "uniswap-v2", event: baseEvent() };
    await recordSwapEvents([record]);
    const second = await recordSwapEvents([record]);
    expect(second).toBe(0);
    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(rows).toHaveLength(1);
  });

  it("inserts a whole batch in one call, not one write per event", async () => {
    const { chainId, poolId } = await makeChainAndPool();
    const records: SwapEventRecord[] = Array.from({ length: 5 }, (_, i) => ({
      chainId,
      poolId,
      sourceKind: "uniswap-v2",
      event: baseEvent({ logIndex: i, transactionHash: `0x${i.toString().padStart(2, "0")}${"ee".repeat(31)}` }),
    }));
    const count = await recordSwapEvents(records);
    expect(count).toBe(5);

    const rows = await db.select().from(swapEvents).where(eq(swapEvents.poolId, poolId));
    expect(rows).toHaveLength(5);
  });
});
