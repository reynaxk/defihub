// Pure unit tests for groupEdgesByCandidate - no RPC, no DB, matching this
// codebase's established convention for the RPC-touching orchestration
// (priceDynamicTokensOnChain itself is not unit-tested here for the same
// reason priceReferenceAssetsOnChain isn't - see engine.test.ts's own
// header comment).
import { describe, expect, it } from "vitest";
import type { DecodedPoolReserves } from "./engine";
import { groupEdgesByCandidate, resolveHopOutcomes, trustedAssetFromOutcome, type TrustedSet } from "./dynamic-engine";
import { pricingAddressKey, type PricingCandidateEdge } from "./dynamic-candidates";
import type { ReferenceAsset } from "./config";

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

// PRODUCTION BUG REGRESSION: resolveHop used to call resolveReferenceAssetOutcome
// with `assetByKey` set to ONLY groupEdgesByCandidate's own output (the
// candidate/derived tokens) - the TRUSTED quote asset each source pairs
// against (source.pairedWithKey) was never in that map, so
// `assetByKey.get(source.pairedWithKey)` (engine.ts) always missed and
// every source was excluded as "not a known reference asset - config
// error," regardless of real on-chain liquidity. This is why the live
// Phase 5.13 run considered 157 candidates and wrote 0 prices. These tests
// exercise resolveHopOutcomes - the actual orchestration shape production
// now goes through (resolveHop itself is RPC-touching and not unit-tested,
// same convention as priceReferenceAssetsOnChain) - with real, valid
// reserves and confirm a candidate successfully resolves against a trusted
// quote asset, at both hop 1 (paired against a hop-0 reference asset) and
// hop 2 (paired against a hop-1-derived token that isn't in REFERENCE_ASSETS
// at all).
describe("resolveHopOutcomes - production orchestration bug regression", () => {
  const CHAIN = "ethereum";
  const BLOCK_NUMBER = BigInt(19000000);
  const BLOCK_HASH = "0x" + "aa".repeat(32);
  const NOW = new Date("2026-08-26T12:00:00.000Z");

  const usdcKey = pricingAddressKey(CHAIN, "0xusdc");
  const usdcTrusted: ReferenceAsset = {
    key: usdcKey,
    chainSlug: CHAIN,
    address: "0xusdc",
    symbol: "USDC",
    decimals: 6,
    coingeckoId: "usd-coin",
    kind: "anchor",
    anchorPriceUsd: "1.00",
  };

  function edge(overrides: Partial<PricingCandidateEdge> = {}): PricingCandidateEdge {
    return {
      poolAddress: "0xpool1",
      chainSlug: CHAIN,
      dexKind: "uniswap-v2",
      candidateAddress: "0xweth",
      candidateDecimals: 18,
      candidateSymbol: "WETH",
      quoteAddressKey: usdcKey,
      quoteAddress: "0xusdc",
      ...overrides,
    };
  }

  it("HOP 1 (the exact reported bug): a candidate paired against a trusted REFERENCE_ASSET resolves successfully when reserves/price are valid - previously always failed with 'not a known reference asset'", () => {
    const trusted: TrustedSet = { priceByKey: new Map([[usdcKey, "1.00"]]), assetByKey: new Map([[usdcKey, usdcTrusted]]) };
    const candidateAssetByKey = groupEdgesByCandidate([edge()]);

    // Same real reserve ratio engine.test.ts's own `decoded()` fixture uses
    // (~4102.48 WETH vs ~10,026,031.35 USDC, well above the $25,000 dynamic
    // floor) - token0/token1 match candidate/trusted addresses exactly.
    const decodedPools = new Map<string, DecodedPoolReserves>([
      ["0xpool1", { reserve0: BigInt("4102476795628499120331"), reserve1: BigInt("10026031352833"), token0: "0xweth", token1: "0xusdc" }],
    ]);

    const [outcome] = resolveHopOutcomes(CHAIN, candidateAssetByKey, trusted, decodedPools, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeUndefined();
    const price = Number(outcome.priceUsd);
    expect(price).toBeGreaterThan(2440);
    expect(price).toBeLessThan(2450);
    expect(outcome.confidence).not.toBe("LOW");
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(true);
    expect(outcome.sources![0].exclusionReason).toBeUndefined();
  });

  it("HOP 2: a candidate paired against a hop-1-resolved token (not itself in REFERENCE_ASSETS) resolves successfully once that token is promoted into the trusted set exactly the way priceDynamicTokensOnChain's own loop promotes it", () => {
    const trusted: TrustedSet = { priceByKey: new Map([[usdcKey, "1.00"]]), assetByKey: new Map([[usdcKey, usdcTrusted]]) };

    // Hop 1: resolve WETH against trusted USDC, exactly as the previous test.
    const hop1Candidates = groupEdgesByCandidate([edge()]);
    const hop1Decoded = new Map<string, DecodedPoolReserves>([
      ["0xpool1", { reserve0: BigInt("4102476795628499120331"), reserve1: BigInt("10026031352833"), token0: "0xweth", token1: "0xusdc" }],
    ]);
    const [wethOutcome] = resolveHopOutcomes(CHAIN, hop1Candidates, trusted, hop1Decoded, NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(wethOutcome.ok).toBe(true); // sanity check - hop 2 below is meaningless if this regressed

    // Promotion - the exact two-map update priceDynamicTokensOnChain's own
    // hop loop performs after a successful, sufficiently-confident outcome.
    trusted.priceByKey.set(wethOutcome.key, wethOutcome.priceUsd!);
    trusted.assetByKey.set(wethOutcome.key, trustedAssetFromOutcome(wethOutcome));

    // Hop 2: WBTC paired against WETH - WETH is NOT a REFERENCE_ASSETS entry
    // in this test fixture at all, so this can only succeed if hop 1's own
    // synthetic trusted-asset record is what resolveHopOutcomes actually
    // used - proving the same union logic that fixed hop 1 also carries a
    // dynamically-derived quote asset into a later hop.
    const hop2Candidates = groupEdgesByCandidate([
      edge({ poolAddress: "0xpool2", candidateAddress: "0xwbtc", candidateDecimals: 8, candidateSymbol: "WBTC", quoteAddressKey: wethOutcome.key, quoteAddress: "0xweth" }),
    ]);
    // ~50 WBTC vs ~1600 WETH - at hop 1's own resolved ~$2445/WETH, that's
    // roughly $7.8M of paired-side liquidity, comfortably above the $25,000
    // dynamic floor.
    const hop2Decoded = new Map<string, DecodedPoolReserves>([
      ["0xpool2", { reserve0: BigInt("5000000000"), reserve1: BigInt("1600000000000000000000"), token0: "0xwbtc", token1: "0xweth" }],
    ]);

    const [wbtcOutcome] = resolveHopOutcomes(CHAIN, hop2Candidates, trusted, hop2Decoded, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(wbtcOutcome.ok).toBe(true);
    expect(wbtcOutcome.error).toBeUndefined();
    expect(wbtcOutcome.sources).toHaveLength(1);
    expect(wbtcOutcome.sources![0].included).toBe(true);
    expect(wbtcOutcome.sources![0].pairedTokenSymbol).toBe("WETH");
    expect(Number(wbtcOutcome.priceUsd)).toBeGreaterThan(0);
  });

  it("CYCLE SAFETY still intact: a hop-1-trusted token is never re-resolved as if it were still a candidate - resolveHopOutcomes only ever returns outcomes for this hop's OWN candidateAssetByKey, never for anything already in trusted.assetByKey", () => {
    const trusted: TrustedSet = { priceByKey: new Map([[usdcKey, "1.00"]]), assetByKey: new Map([[usdcKey, usdcTrusted]]) };
    const candidateAssetByKey = groupEdgesByCandidate([edge()]);
    const decodedPools = new Map<string, DecodedPoolReserves>([
      ["0xpool1", { reserve0: BigInt("4102476795628499120331"), reserve1: BigInt("10026031352833"), token0: "0xweth", token1: "0xusdc" }],
    ]);

    const outcomes = resolveHopOutcomes(CHAIN, candidateAssetByKey, trusted, decodedPools, NOW, BLOCK_NUMBER, BLOCK_HASH);

    // Exactly one outcome (WETH, the only candidate) - USDC (already
    // trusted) never appears in the output, even though it's now present in
    // the merged assetByKey resolveHopOutcomes builds internally.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].key).toBe(pricingAddressKey(CHAIN, "0xweth"));
    expect(outcomes.some((o) => o.key === usdcKey)).toBe(false);
  });
});
