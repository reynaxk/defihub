// Real-Postgres integration tests for findPricingCandidateEdges - same
// isolated-test-chain pattern as lib/onchain/discovery/queries.integration.test.ts,
// reusing recordDiscoveredPools to seed real discovered_pools rows. Uses
// the REAL FACTORY_DEPLOYMENTS keys (not a synthetic one) for the deployment
// each row is recorded under, since findPricingCandidateEdges' own V2-only
// filter looks those up from the real, fixed config - a synthetic
// deploymentKey would simply never match either dexKind and silently
// exclude every row, which is not what these tests are checking.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, discoveredPools } from "@/lib/database/schema";
import { FACTORY_DEPLOYMENTS } from "@/lib/onchain/discovery/config";
import { recordDiscoveredPools } from "@/lib/onchain/discovery/queries";
import type { DecodedPairCreated } from "@/lib/onchain/discovery/scan";
import { findPricingCandidateEdges, pricingAddressKey } from "./dynamic-candidates";

const V2_DEPLOYMENT = FACTORY_DEPLOYMENTS.find((d) => d.dexKind === "uniswap-v2")!;
const V3_DEPLOYMENT = FACTORY_DEPLOYMENTS.find((d) => d.dexKind === "uniswap-v3")!;

describe("findPricingCandidateEdges", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(slug: string): Promise<string> {
    const [chain] = await db.insert(chains).values({ name: `Dynamic Candidates Test ${randomUUID()}`, slug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  function candidate(overrides: Partial<DecodedPairCreated> = {}): DecodedPairCreated {
    return {
      token0: "0xtoken0",
      token1: "0xtoken1",
      poolAddress: "0xpool",
      blockNumber: BigInt(100),
      blockHash: "0x" + "aa".repeat(32),
      transactionHash: "0x" + randomUUID().replace(/-/g, "").padEnd(64, "0"),
      logIndex: 1,
      ...overrides,
    };
  }

  // Bypasses markDiscoveredPoolActive (which requires a real, FK-linked
  // pools.id this test has no need to create) - findPricingCandidateEdges'
  // own dependency, getActiveDiscoveredPools, only requires status='active'
  // and reorgInvalidatedAt IS NULL, neither of which needs a linked pool.
  async function activate(chainId: string, poolAddress: string, decimals0: number, decimals1: number, symbol0: string | null, symbol1: string | null) {
    await db
      .update(discoveredPools)
      .set({ status: "active", token0Decimals: decimals0, token1Decimals: decimals1, token0Symbol: symbol0, token1Symbol: symbol1 })
      .where(eq(discoveredPools.chainId, chainId));
  }

  it("produces an edge when exactly one side is trusted, the untrusted side becoming the candidate", async () => {
    const chainSlug = `dyn-cand-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const deployment = { ...V2_DEPLOYMENT, chainSlug };
    await recordDiscoveredPools(chainId, deployment, [candidate({ token0: "0xtrusted", token1: "0xnottrusted", poolAddress: "0xpoolA" })]);
    await activate(chainId, "0xpoolA", 18, 18, "TRUST", "NOTRUST");

    const trusted = new Set([pricingAddressKey(chainSlug, "0xtrusted")]);
    const edges = await findPricingCandidateEdges(trusted);
    const forThisChain = edges.filter((e) => e.chainSlug === chainSlug);

    expect(forThisChain).toHaveLength(1);
    expect(forThisChain[0].candidateAddress).toBe("0xnottrusted");
    expect(forThisChain[0].quoteAddress).toBe("0xtrusted");
  });

  it("produces NO edge when both sides are already trusted - nothing new to price", async () => {
    const chainSlug = `dyn-cand-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const deployment = { ...V2_DEPLOYMENT, chainSlug };
    await recordDiscoveredPools(chainId, deployment, [candidate({ token0: "0xtrustedA", token1: "0xtrustedB", poolAddress: "0xpoolB" })]);
    await activate(chainId, "0xpoolB", 18, 18, "A", "B");

    const trusted = new Set([pricingAddressKey(chainSlug, "0xtrustedA"), pricingAddressKey(chainSlug, "0xtrustedB")]);
    const edges = await findPricingCandidateEdges(trusted);
    expect(edges.filter((e) => e.chainSlug === chainSlug)).toHaveLength(0);
  });

  it("produces NO edge when NEITHER side is trusted yet - correctly deferred, never guessed", async () => {
    const chainSlug = `dyn-cand-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const deployment = { ...V2_DEPLOYMENT, chainSlug };
    await recordDiscoveredPools(chainId, deployment, [candidate({ token0: "0xunknownA", token1: "0xunknownB", poolAddress: "0xpoolC" })]);
    await activate(chainId, "0xpoolC", 18, 18, "A", "B");

    const edges = await findPricingCandidateEdges(new Set());
    expect(edges.filter((e) => e.chainSlug === chainSlug)).toHaveLength(0);
  });

  it("V2-ONLY: excludes a V3 deployment's pool even when exactly one side is trusted - deriveV2Price cannot price a pool with no getReserves()", async () => {
    const chainSlug = `dyn-cand-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const deployment = { ...V3_DEPLOYMENT, chainSlug };
    await recordDiscoveredPools(chainId, deployment, [candidate({ token0: "0xtrusted", token1: "0xv3token", poolAddress: "0xpoolV3" })]);
    await activate(chainId, "0xpoolV3", 18, 18, "TRUST", "V3TOK");

    const trusted = new Set([pricingAddressKey(chainSlug, "0xtrusted")]);
    const edges = await findPricingCandidateEdges(trusted);
    expect(edges.filter((e) => e.chainSlug === chainSlug)).toHaveLength(0);
  });

  it("a still-pending (not yet validated/active) discovered pool never becomes a candidate", async () => {
    const chainSlug = `dyn-cand-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const deployment = { ...V2_DEPLOYMENT, chainSlug };
    await recordDiscoveredPools(chainId, deployment, [candidate({ token0: "0xtrusted", token1: "0xpending", poolAddress: "0xpoolD" })]);
    // Deliberately never activated - stays status='discovered'.

    const trusted = new Set([pricingAddressKey(chainSlug, "0xtrusted")]);
    const edges = await findPricingCandidateEdges(trusted);
    expect(edges.filter((e) => e.chainSlug === chainSlug)).toHaveLength(0);
  });
});
