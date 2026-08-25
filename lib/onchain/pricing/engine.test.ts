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

const assetByKey = new Map([
  [anchor.key, anchor],
  [weth.key, weth],
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

  it("fails explicitly when the pool's on-chain token0/token1 do not match the configured pair, never substituting or guessing", () => {
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const mismatched = decoded({ token0: "0xsomethingelse" as const });
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, mismatched, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(false);
    expect(outcome.sources).toHaveLength(1);
    expect(outcome.sources![0].included).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/do not match the configured pair/);
  });

  it("fails explicitly when the pool's on-chain read itself failed (null reserves/token0/token1), never fabricating a value", () => {
    const resolvedPriceByKey = new Map([["usdc-test", "1.00"]]);
    const failed = decoded({ reserve0: null, reserve1: null, token0: null, token1: null });
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, failed, resolvedPriceByKey, NOW, BLOCK_NUMBER, BLOCK_HASH);

    expect(outcome.ok).toBe(false);
    expect(outcome.sources![0].exclusionReason).toMatch(/read failed/);
  });

  it("fails explicitly when its own dependency has not been resolved yet, rather than pricing against a missing reference", () => {
    // No entry for "usdc-test" in resolvedPriceByKey at all.
    const outcome = resolveReferenceAssetOutcome(weth, assetByKey, decoded(), new Map(), NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not been resolved yet/);
  });

  it("fails explicitly when a derived asset has no configured source pools at all", () => {
    const noSources: ReferenceAsset = { ...weth, sourcePools: [] };
    const outcome = resolveReferenceAssetOutcome(noSources, assetByKey, decoded(), new Map([["usdc-test", "1.00"]]), NOW, BLOCK_NUMBER, BLOCK_HASH);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no configured source pools/);
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
