// Pure unit tests for resolveReferenceAssetOutcome and
// buildReferenceAssetMulticallCalls - no RPC, no mocked chain client,
// matching this codebase's established convention (resolveVaultOutcome in
// verify-vault.ts is the direct precedent). priceReferenceAssetsOnChain
// itself (the RPC-touching orchestration) is not unit-tested here for the
// same reason verifyPoolsOnChain/verifyVaultsOnChain aren't.
import { describe, expect, it } from "vitest";
import { buildReferenceAssetMulticallCalls, CALLS_PER_SOURCE_POOL, resolveReferenceAssetOutcome, type DecodedPoolReserves } from "./engine";
import type { ReferenceAsset } from "./config";

const anchor: ReferenceAsset = {
  key: "usdc-test",
  chainSlug: "ethereum",
  address: "0xusdc",
  symbol: "USDC",
  decimals: 6,
  coingeckoId: "usd-coin",
  kind: "anchor",
  anchorPriceUsd: "1.00",
};

const weth: ReferenceAsset = {
  key: "weth-test",
  chainSlug: "ethereum",
  address: "0xweth",
  symbol: "WETH",
  decimals: 18,
  coingeckoId: "weth",
  kind: "derived",
  sourcePools: [{ poolAddress: "0xpool1", dexKind: "uniswap-v2", pairedWithKey: "usdc-test" }],
};

// A second reference asset used only by the multi-source tests below - not
// itself resolvable (no entry in resolvedPriceByKey), so any source pairing
// against it exercises the "unresolved dependency" exclusion path
// alongside a genuinely valid source for the SAME asset.
const unresolvedRef: ReferenceAsset = {
  key: "unresolved-ref-test",
  chainSlug: "ethereum",
  address: "0xunresolved",
  symbol: "UNR",
  decimals: 18,
  coingeckoId: "unresolved-ref",
  kind: "derived",
  sourcePools: [{ poolAddress: "0xnever-read", dexKind: "uniswap-v2", pairedWithKey: "usdc-test" }],
};

// WETH-shaped, but with TWO configured source pools: one paired against
// unresolvedRef (never resolvable in these tests), one paired against the
// real, resolvable anchor - the exact shape Finding #4's regression test
// needs.
const wethTwoSources: ReferenceAsset = {
  ...weth,
  key: "weth-two-sources-test",
  sourcePools: [
    { poolAddress: "0xpool-unresolved", dexKind: "uniswap-v2", pairedWithKey: "unresolved-ref-test" },
    { poolAddress: "0xpool1", dexKind: "uniswap-v2", pairedWithKey: "usdc-test" },
  ],
};

const assetByKey = new Map([
  [anchor.key, anchor],
  [weth.key, weth],
  [unresolvedRef.key, unresolvedRef],
  [wethTwoSources.key, wethTwoSources],
]);

const BLOCK_NUMBER = BigInt(19000000);
const BLOCK_HASH = "0x" + "aa".repeat(32);
const NOW = new Date("2026-08-26T12:00:00.000Z");

function decoded(overrides: Partial<DecodedPoolReserves> = {}): Map<string, DecodedPoolReserves> {
  return new Map([
    [
      "0xpool1",
      {
        // WETH reserve, USDC reserve - token0=WETH, token1=USDC (arbitrary
        // ordering, exercised the same as the real pool's own token0/token1
        // check).
        reserve0: BigInt("4102476795628499120331"),
        reserve1: BigInt("10026031352833"),
        token0: "0xweth" as const,
        token1: "0xusdc" as const,
        ...overrides,
      },
    ],
  ]);
}

describe("resolveReferenceAssetOutcome", () => {
  it("resolves the anchor directly, without consulting any pool, at MEDIUM confidence", () => {
    const outcome = resolveReferenceAssetOutcome(anchor, assetByKey, new Map(), new Map(), NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(outcome.ok).toBe(true);
    expect(outcome.priceUsd).toBe("1.00");
    expect(outcome.confidence).toBe("MEDIUM");
    expect(outcome.label).toBe("ONCHAIN_NATIVE");
    expect(outcome.sources).toEqual([]);
  });

  it("resolves a derived asset successfully from a matching, well-reserved pool", () => {
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, decoded(), resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(true);
    const price = Number(outcome.priceUsd);
    expect(price).toBeGreaterThan(2440);
    expect(price).toBeLessThan(2450);
    expect(outcome.blockNumber).toBe(BLOCK_NUMBER);
    expect(outcome.blockHash).toBe(BLOCK_HASH);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(true);
  });

  it("fails explicitly when the pool's on-chain token0/token1 do not match the configured pair, but preserves the reserves the chain actually returned (known but excluded, not unknown)", () => {
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const mismatched = decoded({ token0: "0xsomethingelse" as const });
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, mismatched, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(false);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/do not match the configured pair/);
    // The chain read succeeded (it's the pairing that's wrong, not the
    // read) - the raw reserves and the already-resolved paired price are
    // real, known values, not fabricated, and must not be zeroed out.
    expect(outcome.sources![0].reserveRaw).toBe("4102476795628499120331");
    expect(outcome.sources![0].pairedReserveRaw).toBe("10026031352833");
    expect(outcome.sources![0].pairedTokenPriceUsd).toBe("1.00");
  });

  it("fails explicitly when the pool's on-chain read itself failed (null reserves/token0/token1), and correctly leaves every value unknown - genuinely nothing was read", () => {
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const failed = decoded({ reserve0: null, reserve1: null, token0: null, token1: null });
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, failed, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/read failed/);
    // Nothing was actually read here - unlike the pair-mismatch case above,
    // these values are genuinely unknown, so "0" is correct, not a lost
    // known value.
    expect(outcome.sources![0].reserveRaw).toBe("0");
    expect(outcome.sources![0].pairedReserveRaw).toBe("0");
    expect(outcome.sources![0].pairedTokenPriceUsd).toBe("0");
  });

  it("excludes a source whose derived price/liquidity itself failed (e.g. below the minimum-liquidity floor), preserving the reserves and paired price that were fed into it", () => {
    // Reserves scaled down far enough that deriveV2Price's own liquidity
    // floor rejects them (see uniswap-v2.ts's MIN_LIQUIDITY_USD /
    // aggregate.ts's PRICING_THRESHOLDS.MIN_LIQUIDITY_USD, $10,000) - a
    // genuinely different failure than a chain-read failure or a pair
    // mismatch: the read succeeded and the pairing is correct, only the
    // resulting pool is too thin to trust.
    const tinyPool = decoded({ reserve0: BigInt("1000000000000000"), reserve1: BigInt("1000") }); // ~$0.000001 liquidity
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, tinyPool, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(false);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/liquidity/);
    expect(outcome.sources![0].reserveRaw).toBe("1000000000000000");
    expect(outcome.sources![0].pairedReserveRaw).toBe("1000");
    expect(outcome.sources![0].pairedTokenPriceUsd).toBe("1.00");
  });

  it("fails explicitly when its own dependency has not been resolved yet, recording the reason on the excluded source rather than only a top-level error", () => {
    // No entry for "usdc-test" in resolvedPriceByKey at all.
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, decoded(), new Map(), NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(outcome.ok).toBe(false);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/not been resolved yet/);
  });

  it("fails explicitly when a derived asset has no configured source pools at all", () => {
    const noSources: ReferenceAsset = { ...weth, sourcePools: [] };
    const outcome = resolveReferenceAssetOutcome(noSources, assetByKey, decoded(), new Map([["usdc-test", "1.00"]]), NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no configured source pools/);
  });

  it("succeeds using the one valid source when a SECOND configured source has an unresolved dependency, never letting the bad source contaminate or invalidate the good one", () => {
    // wethTwoSources has two configured pools: one paired against
    // unresolvedRef (never given a price below - genuinely unresolved),
    // one paired against the real anchor (resolved to $1.00, the same
    // well-reserved pool `decoded()` already sets up).
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]); // unresolved-ref-test deliberately absent
    const decodedTwoPools = new Map(decoded());
    decodedTwoPools.set("0xpool-unresolved", {
      reserve0: BigInt("1"),
      reserve1: BigInt("1"),
      token0: "0xweth",
      token1: "0xunresolved",
    });

    const outcome = resolveReferenceAssetOutcome(wethTwoSources, assetByKey, decodedTwoPools, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(true);
    const price = Number(outcome.priceUsd);
    expect(price).toBeGreaterThan(2440);
    expect(price).toBeLessThan(2450);

    expect(outcome.sources).toHaveLength(2);
    const excluded = outcome.sources!.filter((s) => !s.included);
    const included = outcome.sources!.filter((s) => s.included);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].sourcePoolAddress).toBe("0xpool-unresolved");
    expect(excluded[0].exclusionReason).toMatch(/not been resolved yet/);
    expect(included).toHaveLength(1);
    expect(included[0].sourcePoolAddress).toBe("0xpool1");
  });

  describe("Phase 5.13: the optional minLiquidityUsd parameter", () => {
    it("REGRESSION: defaults to the exact same PRICING_THRESHOLDS.MIN_LIQUIDITY_USD every pre-existing caller relied on when omitted", () => {
      const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
      const outcome = resolveReferenceAssetOutcome(weth, assetByKey, decoded(), resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);
      expect(outcome.ok).toBe(true); // unchanged from the "resolves a derived asset successfully" test above
    });

    it("a stricter caller-supplied threshold rejects a pool that would have passed the default $10,000 floor - the dynamic-pricing engine's own stricter MIN_LIQUIDITY_USD_DYNAMIC ($25,000) applied to this test's own real ~$20M pool would NOT reject it, so this uses a pool sized specifically between the two floors", () => {
      // ~$20,053 of USDC-side liquidity (2x one side, per deriveV2Price's
      // own convention) - clears the default $10,000 floor but not a
      // stricter $25,000 one.
      const betweenFloors = decoded({ reserve0: BigInt("8000000000000000000"), reserve1: BigInt("10026500000") });
      const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);

      const withDefault = resolveReferenceAssetOutcome(weth, assetByKey, betweenFloors, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);
      expect(withDefault.ok).toBe(true);

      const withStricterFloor = resolveReferenceAssetOutcome(weth, assetByKey, betweenFloors, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH, "25000");
      expect(withStricterFloor.ok).toBe(false);
      expect(withStricterFloor.sources![0].exclusionReason).toMatch(/liquidity/);
    });
  });
});

describe("buildReferenceAssetMulticallCalls", () => {
  it("emits exactly getReserves(), token0(), token1() for each pool address, in that order", () => {
    const calls = buildReferenceAssetMulticallCalls(["0xpool1", "0xpool2"]);
    expect(calls).toHaveLength(2 * CALLS_PER_SOURCE_POOL);
    expect(calls[0]).toMatchObject({ address: "0xpool1", functionName: "getReserves" });
    expect(calls[1]).toMatchObject({ address: "0xpool1", functionName: "token0" });
    expect(calls[2]).toMatchObject({ address: "0xpool1", functionName: "token1" });
    expect(calls[3]).toMatchObject({ address: "0xpool2", functionName: "getReserves" });
  });

  it("returns an empty array for an empty pool list, never throwing", () => {
    expect(buildReferenceAssetMulticallCalls([])).toEqual([]);
  });
});
