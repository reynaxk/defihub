// Real-Postgres integration tests proving the hop-by-hop resolution
// pattern dynamic-engine.ts's own priceDynamicTokensOnChain uses is
// genuinely cycle-safe BY CONSTRUCTION (Part 3) - simulated here by
// calling the real findPricingCandidateEdges across successive "rounds"
// with a manually-evolved trusted set, exactly mirroring what
// priceDynamicTokensOnChain's own hop loop does internally, without
// needing a mocked chain client (this file never calls priceDynamicTokensOnChain
// itself - the RPC-touching orchestration is intentionally not unit-tested,
// same convention as priceReferenceAssetsOnChain/verifyPoolsOnChain).
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

describe("dynamic pricing hop resolution - cycle safety and multi-hop (Part 3)", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(slug: string): Promise<string> {
    const [chain] = await db.insert(chains).values({ name: `Dynamic Engine Cycle Test ${randomUUID()}`, slug, nativeToken: "TST" }).returning({ id: chains.id });
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

  async function activate(chainId: string) {
    await db.update(discoveredPools).set({ status: "active", token0Decimals: 18, token1Decimals: 18, token0Symbol: "T0", token1Symbol: "T1" }).where(eq(discoveredPools.chainId, chainId));
  }

  it("MULTI-HOP: a token reachable only via a pool paired against a HOP-1-derived token becomes a hop-2 candidate, never a hop-1 one", async () => {
    const chainSlug = `dyn-cycle-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const dep = { ...V2_DEPLOYMENT, chainSlug };

    // P1: USDC (trusted, hop 0) <-> TokenA - a genuine hop-1 candidate.
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xusdc", token1: "0xa", poolAddress: "0xp1", transactionHash: "0x" + "01".repeat(32) })]);
    // P2: TokenA <-> TokenB - TokenB is reachable ONLY through TokenA, so it
    // must not appear as a candidate until TokenA is itself trusted.
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xa", token1: "0xb", poolAddress: "0xp2", transactionHash: "0x" + "02".repeat(32) })]);
    await activate(chainId);

    const hop0Trusted = new Set([pricingAddressKey(chainSlug, "0xusdc")]);
    const hop1Edges = (await findPricingCandidateEdges(hop0Trusted)).filter((e) => e.chainSlug === chainSlug);

    // Only TokenA is reachable at hop 1 - TokenB's own pool (P2) has NEITHER
    // side trusted yet (TokenA isn't trusted until hop 1 resolves it), so
    // it correctly contributes nothing this round.
    expect(hop1Edges).toHaveLength(1);
    expect(hop1Edges[0].candidateAddress).toBe("0xa");

    // Simulates dynamic-engine.ts's own post-hop-1 promotion: TokenA
    // resolved successfully this round, so it joins the trusted set for
    // hop 2.
    const hop1Trusted = new Set([...hop0Trusted, pricingAddressKey(chainSlug, "0xa")]);
    const hop2Edges = (await findPricingCandidateEdges(hop1Trusted)).filter((e) => e.chainSlug === chainSlug);

    expect(hop2Edges).toHaveLength(1);
    expect(hop2Edges[0].candidateAddress).toBe("0xb");
    expect(hop2Edges[0].quoteAddress).toBe("0xa"); // priced against the hop-1-derived token, not directly against USDC
  });

  it("CYCLE SAFETY: once a token is trusted, NO pool - including one explicitly pairing it back against a later-derived token - can ever produce a new edge for it again", async () => {
    const chainSlug = `dyn-cycle-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const dep = { ...V2_DEPLOYMENT, chainSlug };

    // P1: USDC <-> TokenA (hop 1). P2: TokenA <-> TokenB (hop 2).
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xusdc", token1: "0xa", poolAddress: "0xp1", transactionHash: "0x" + "11".repeat(32) })]);
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xa", token1: "0xb", poolAddress: "0xp2", transactionHash: "0x" + "12".repeat(32) })]);
    // P3: the adversarial pool - pairs TokenB back against TokenA. If
    // cycle-safety didn't hold, this could be (mis)used to "re-derive"
    // TokenA's own price from TokenB after the fact.
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xb", token1: "0xa", poolAddress: "0xp3", transactionHash: "0x" + "13".repeat(32) })]);
    await activate(chainId);

    // After hop 1 (TokenA trusted) and hop 2 (TokenB trusted, using P2 -
    // P3 also qualifies here since it's a SECOND independent pool pricing
    // TokenB against TokenA, which is fine: real corroboration, not a
    // cycle, since TokenA is already the TRUSTED side for both).
    const fullyTrusted = new Set([pricingAddressKey(chainSlug, "0xusdc"), pricingAddressKey(chainSlug, "0xa"), pricingAddressKey(chainSlug, "0xb")]);

    const hop3Edges = (await findPricingCandidateEdges(fullyTrusted)).filter((e) => e.chainSlug === chainSlug);

    // Every pool (P1, P2, P3) now has BOTH sides trusted - none of them can
    // ever produce a new edge again, for TokenA, TokenB, or anything else.
    // This is the concrete proof: no pool - not even one explicitly
    // structured to pair a derived token back against its own ancestor -
    // can ever be used to re-price (or "confirm via a cycle") a
    // already-trusted token.
    expect(hop3Edges).toHaveLength(0);
  });

  it("CYCLE SAFETY: P3 (TokenB paired against TokenA) is correctly used as hop-2 CORROBORATION for TokenB, not as a path back to re-price TokenA", async () => {
    const chainSlug = `dyn-cycle-${randomUUID().slice(0, 8)}`;
    const chainId = await makeChain(chainSlug);
    const dep = { ...V2_DEPLOYMENT, chainSlug };

    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xusdc", token1: "0xa", poolAddress: "0xp1", transactionHash: "0x" + "21".repeat(32) })]);
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xa", token1: "0xb", poolAddress: "0xp2", transactionHash: "0x" + "22".repeat(32) })]);
    await recordDiscoveredPools(chainId, dep, [candidate({ token0: "0xb", token1: "0xa", poolAddress: "0xp3", transactionHash: "0x" + "23".repeat(32) })]);
    await activate(chainId);

    const hop1Trusted = new Set([pricingAddressKey(chainSlug, "0xusdc"), pricingAddressKey(chainSlug, "0xa")]);
    const hop2Edges = (await findPricingCandidateEdges(hop1Trusted)).filter((e) => e.chainSlug === chainSlug);

    // Both P2 and P3 independently price TokenB against TokenA - real,
    // legitimate corroboration (Part 8), grouped by groupEdgesByCandidate
    // into ONE synthetic asset with two sourcePools. Neither produces an
    // edge for TokenA (already trusted) or anything else.
    expect(hop2Edges).toHaveLength(2);
    expect(hop2Edges.every((e) => e.candidateAddress === "0xb")).toBe(true);
    expect(new Set(hop2Edges.map((e) => e.poolAddress))).toEqual(new Set(["0xp2", "0xp3"]));
  });
});
