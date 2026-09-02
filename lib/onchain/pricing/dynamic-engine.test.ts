// Pure unit tests for groupEdgesByCandidate - no RPC, no DB, matching this
// codebase's established convention for the RPC-touching orchestration
// (priceDynamicTokensOnChain itself is not unit-tested here for the same
// reason priceReferenceAssetsOnChain isn't - see engine.test.ts's own
// header comment).
import { describe, expect, it } from "vitest";
import { groupEdgesByCandidate } from "./dynamic-engine";
import type { PricingCandidateEdge } from "./dynamic-candidates";

function edge(overrides: Partial<PricingCandidateEdge> = {}): PricingCandidateEdge {
  return {
    poolAddress: "0xpool1",
    chainSlug: "ethereum",
    dexKind: "uniswap-v2",
    candidateAddress: "0xcandidate",
    candidateDecimals: 18,
    candidateSymbol: "CAND",
    quoteAddressKey: "ethereum:0xusdc",
    quoteAddress: "0xusdc",
    ...overrides,
  };
}

describe("groupEdgesByCandidate", () => {
  it("builds one synthetic derived ReferenceAsset per distinct candidate token", () => {
    const assetByKey = groupEdgesByCandidate([edge({ candidateAddress: "0xa" }), edge({ candidateAddress: "0xb" })]);
    expect(assetByKey.size).toBe(2);
    expect([...assetByKey.keys()]).toEqual(["ethereum:0xa", "ethereum:0xb"]);
  });

  it("PROVENANCE (Part 7): the synthetic asset's key is exactly pricingAddressKey(chainSlug, candidateAddress) - a token's own identity is always its on-chain address, never a human-chosen label", () => {
    const [asset] = [...groupEdgesByCandidate([edge({ chainSlug: "bnb-chain", candidateAddress: "0xABC" })]).values()];
    expect(asset.key).toBe("bnb-chain:0xabc");
    expect(asset.kind).toBe("derived");
  });

  it("CORROBORATION (Part 8): a candidate reachable via MULTIPLE independent pools gets ALL of them as sourcePools on one synthetic asset - fed to the exact same multi-source aggregatePrices/classifyConfidence machinery REFERENCE_ASSETS' own multi-pool entries already use, never a bespoke corroboration path", () => {
    const edges = [
      edge({ candidateAddress: "0xshared", poolAddress: "0xpoolA", quoteAddressKey: "ethereum:0xusdc" }),
      edge({ candidateAddress: "0xshared", poolAddress: "0xpoolB", quoteAddressKey: "ethereum:0xweth" }),
    ];
    const [asset] = [...groupEdgesByCandidate(edges).values()];
    expect(asset.sourcePools).toHaveLength(2);
    expect(asset.sourcePools!.map((p) => p.poolAddress)).toEqual(["0xpoolA", "0xpoolB"]);
    expect(asset.sourcePools!.map((p) => p.pairedWithKey)).toEqual(["ethereum:0xusdc", "ethereum:0xweth"]);
  });

  it("uses the first edge's own decimals/symbol for the synthetic asset - every edge for the same candidate token carries the identical on-chain-verified decimals, since it's the same real token regardless of which pool discovered it", () => {
    const edges = [edge({ candidateAddress: "0xshared", candidateDecimals: 6, candidateSymbol: "USDX" }), edge({ candidateAddress: "0xshared", poolAddress: "0xpoolB", candidateDecimals: 6, candidateSymbol: "USDX" })];
    const [asset] = [...groupEdgesByCandidate(edges).values()];
    expect(asset.decimals).toBe(6);
    expect(asset.symbol).toBe("USDX");
  });

  it("falls back to the token's own key when no real symbol was read (a failed/best-effort symbol() call) - never fabricated, matching this codebase's established 'no symbol -> use identity' convention", () => {
    const [asset] = [...groupEdgesByCandidate([edge({ candidateSymbol: null })]).values()];
    expect(asset.symbol).toBe(asset.key);
  });

  it("returns an empty map for an empty edge list", () => {
    expect(groupEdgesByCandidate([]).size).toBe(0);
  });
});
