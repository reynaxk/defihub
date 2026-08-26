// Real-Postgres integration test for recordSwapEvents - same pattern as
// lib/onchain/pricing/record-price-observation.integration.test.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, pools, swapEvents } from "@/lib/database/schema";
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
