// Real-Postgres integration tests for the discovered_pools query layer -
// same pattern as lib/onchain/volume/record-swap-events.integration.test.ts.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, discoveredPools, pools } from "@/lib/database/schema";
import type { FactoryDeployment } from "./config";
import {
  getActiveDiscoveredPools,
  getPendingDiscoveredPools,
  markDiscoveredPoolActive,
  markDiscoveredPoolRejected,
  recordDiscoveredPools,
} from "./queries";
import type { DecodedPairCreated } from "./scan";

describe("discovered_pools queries", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<string> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Discovery Test Chain ${randomUUID()}`, slug: `discovery-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  function deployment(overrides: Partial<FactoryDeployment> = {}): FactoryDeployment {
    return {
      key: `test-deployment-${randomUUID()}`,
      chainSlug: "test-chain",
      protocolDefillamaSlug: "test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0xfactory",
      feeBps: 30,
      startBlock: BigInt(1),
      ...overrides,
    };
  }

  function candidate(overrides: Partial<DecodedPairCreated> = {}): DecodedPairCreated {
    return {
      token0: "0xtoken0",
      token1: "0xtoken1",
      poolAddress: "0xpooladdress",
      blockNumber: BigInt(100),
      blockHash: "0x" + "aa".repeat(32),
      transactionHash: "0x" + "bb".repeat(32),
      logIndex: 5,
      ...overrides,
    };
  }

  it("DUPLICATE: recording the same candidate twice creates exactly one row - same factory event twice -> one pool", async () => {
    const chainId = await makeChain();
    const dep = deployment();
    const c = candidate();

    const first = await recordDiscoveredPools(chainId, dep, [c]);
    const second = await recordDiscoveredPools(chainId, dep, [c]);

    expect(first).toBe(1);
    expect(second).toBe(0);

    const rows = await db.select().from(discoveredPools).where(eq(discoveredPools.chainId, chainId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("discovered");
  });

  it("batches an empty candidate list as a true no-op, never erroring", async () => {
    const chainId = await makeChain();
    expect(await recordDiscoveredPools(chainId, deployment(), [])).toBe(0);
  });

  it("inserts a whole batch of distinct candidates in one call", async () => {
    const chainId = await makeChain();
    const dep = deployment();
    const count = await recordDiscoveredPools(chainId, dep, [
      candidate({ poolAddress: "0xpoolA", transactionHash: "0x" + "01".repeat(32) }),
      candidate({ poolAddress: "0xpoolB", transactionHash: "0x" + "02".repeat(32) }),
      candidate({ poolAddress: "0xpoolC", transactionHash: "0x" + "03".repeat(32) }),
    ]);
    expect(count).toBe(3);
  });

  it("REORG SELF-HEAL: re-discovering a REJECTED pool refreshes its provenance and returns it to 'discovered' for re-validation", async () => {
    const chainId = await makeChain();
    const dep = deployment();
    const original = candidate({ blockHash: "0x" + "11".repeat(32), blockNumber: BigInt(100) });

    await recordDiscoveredPools(chainId, dep, [original]);
    const [row] = await db.select().from(discoveredPools).where(eq(discoveredPools.chainId, chainId));
    await markDiscoveredPoolRejected(row.id, "creation block is no longer canonical for this chain");

    // The real canonical creation event is later re-discovered at a
    // DIFFERENT block/hash for the exact same pool address.
    const canonical = candidate({ ...original, blockHash: "0x" + "22".repeat(32), blockNumber: BigInt(150), transactionHash: "0x" + "33".repeat(32) });
    const reinserted = await recordDiscoveredPools(chainId, dep, [canonical]);

    expect(reinserted).toBe(1); // the upsert branch counts as a "returning" row too
    const rows = await db.select().from(discoveredPools).where(eq(discoveredPools.chainId, chainId));
    expect(rows).toHaveLength(1); // still one row, not a duplicate
    expect(rows[0].status).toBe("discovered");
    expect(rows[0].rejectionReason).toBeNull();
    expect(rows[0].creationBlockHash).toBe("0x" + "22".repeat(32));
    expect(rows[0].creationBlockNumber).toBe("150");
  });

  it("does NOT touch an already-'active' row on re-discovery - only a 'rejected' row is refreshed", async () => {
    const chainId = await makeChain();
    const dep = deployment();
    const original = candidate();

    await recordDiscoveredPools(chainId, dep, [original]);
    const [row] = await db.select().from(discoveredPools).where(eq(discoveredPools.chainId, chainId));
    const [poolRow] = await db
      .insert(pools)
      .values({ configKey: `discovered:${randomUUID()}`, chainId, label: "test pool", address: original.poolAddress })
      .returning({ id: pools.id });
    await markDiscoveredPoolActive(row.id, 18, 18, poolRow.id);

    const replay = candidate({ ...original, blockHash: "0x" + "99".repeat(32) });
    await recordDiscoveredPools(chainId, dep, [replay]);

    const [after] = await db.select().from(discoveredPools).where(eq(discoveredPools.chainId, chainId));
    expect(after.status).toBe("active");
    expect(after.creationBlockHash).toBe(original.blockHash); // untouched, not overwritten by the replay
  });

  it("getPendingDiscoveredPools only returns 'discovered' status rows for the given deployment, bounded by limit", async () => {
    const chainId = await makeChain();
    const depA = deployment({ key: "dep-a" });
    const depB = deployment({ key: "dep-b" });

    await recordDiscoveredPools(chainId, depA, [candidate({ poolAddress: "0xa1", transactionHash: "0x" + "a1".repeat(32) })]);
    await recordDiscoveredPools(chainId, depA, [candidate({ poolAddress: "0xa2", transactionHash: "0x" + "a2".repeat(32) })]);
    await recordDiscoveredPools(chainId, depB, [candidate({ poolAddress: "0xb1", transactionHash: "0x" + "b1".repeat(32) })]);

    const pendingA = await getPendingDiscoveredPools(depA.key, 10);
    expect(pendingA).toHaveLength(2);
    expect(pendingA.every((p) => p.deploymentKey === depA.key)).toBe(true);

    const limited = await getPendingDiscoveredPools(depA.key, 1);
    expect(limited).toHaveLength(1);
  });

  it("getActiveDiscoveredPools excludes 'discovered' and 'rejected' rows, includes only 'active' ones with resolved decimals", async () => {
    const chainId = await makeChain();
    const dep = deployment({ chainSlug: "discovery-active-test" });

    await recordDiscoveredPools(chainId, dep, [candidate({ poolAddress: "0xpending", transactionHash: "0x" + "p1".repeat(32) })]);

    await recordDiscoveredPools(chainId, dep, [candidate({ poolAddress: "0xrejected", transactionHash: "0x" + "r1".repeat(32) })]);
    const [rejectedRow] = await db.select().from(discoveredPools).where(eq(discoveredPools.poolAddress, "0xrejected"));
    await markDiscoveredPoolRejected(rejectedRow.id, "test rejection");

    await recordDiscoveredPools(chainId, dep, [candidate({ poolAddress: "0xactive", transactionHash: "0x" + "ac".repeat(32) })]);
    const [activeRow] = await db.select().from(discoveredPools).where(eq(discoveredPools.poolAddress, "0xactive"));
    const [poolRow] = await db
      .insert(pools)
      .values({ configKey: `discovered:${randomUUID()}`, chainId, label: "test active pool", address: "0xactive" })
      .returning({ id: pools.id });
    await markDiscoveredPoolActive(activeRow.id, 6, 18, poolRow.id);

    const [chainSlugRow] = await db.select({ slug: chains.slug }).from(chains).where(eq(chains.id, chainId));
    const active = await getActiveDiscoveredPools();
    const forThisChain = active.filter((a) => a.chainSlug === chainSlugRow.slug);

    expect(forThisChain).toHaveLength(1);
    expect(forThisChain[0].poolAddress).toBe("0xactive");
    expect(forThisChain[0].token0Decimals).toBe(6);
    expect(forThisChain[0].token1Decimals).toBe(18);
  });
});
