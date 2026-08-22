// Deterministic unit tests for computePoolTvl - the pure "raw on-chain
// balance + decimals + USD price -> pool TVL" math extracted from
// verifyPoolsOnChain specifically so it's testable without a real
// multicall/RPC round-trip. This is DeFiHub's own native TVL calculation
// (see this file's module comment and docs/native-data.md) - price is the
// one external input (CoinGecko, via PriceProvider), everything else -
// reading the balance, normalizing it, valuing it - is computed here.
//
// BigInt values use BigInt(...) calls rather than `n`-suffixed literals -
// same convention as lib/indexing/events.ts (BigInt(2000)), since this
// project's TS target doesn't support BigInt literal syntax.
import { describe, expect, it } from "vitest";
import type { HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { computePoolTvl, type PoolTvlToken } from "./verify-pool";

function pow10(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

describe("computePoolTvl", () => {
  it("the canonical worked example: Token A (100, 18 dec, $2) + Token B (50, 18 dec, $4) = $400", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "A", decimals: 18, coingeckoId: "token-a" },
      { symbol: "B", decimals: 18, coingeckoId: "token-b" },
    ];
    const balances = [BigInt(100) * pow10(18), BigInt(50) * pow10(18)];
    const prices = new Map([
      ["token-a", 2],
      ["token-b", 4],
    ]);

    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe(400);
  });

  it("handles different decimals correctly (e.g. USDC's 6 vs WETH's 18)", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
      { symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    ];
    // 1,000,000 USDC (raw units) = 1 USDC at 6 decimals; 1 WETH at 18 decimals.
    const balances = [BigInt(1_000_000), pow10(18)];
    const prices = new Map([
      ["usd-coin", 1],
      ["weth", 3000],
    ]);

    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe(3001);
  });

  it("a zero balance is a real, valid value - contributes $0, not an error", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "A", decimals: 18, coingeckoId: "token-a" }];
    const result = computePoolTvl(tokens, [BigInt(0)], new Map([["token-a", 5]]));
    expect(result).toEqual({ ok: true, tvlUsd: 0 });
  });

  it("a failed balance read (null) fails the whole pool, never treated as zero", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "A", decimals: 18, coingeckoId: "token-a" },
      { symbol: "B", decimals: 18, coingeckoId: "token-b" },
    ];
    const result = computePoolTvl(tokens, [pow10(18), null], new Map([["token-a", 1], ["token-b", 1]]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("B");
  });

  it("a missing USD price fails the pool rather than substituting a fabricated price", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "UNKNOWN", decimals: 18, coingeckoId: "no-such-id" }];
    const result = computePoolTvl(tokens, [pow10(18)], new Map());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("UNKNOWN");
  });

  it("handles a huge balance without overflow or precision collapse", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "BIG", decimals: 18, coingeckoId: "big-token" }];
    // 10 billion tokens at 18 decimals - a genuinely large but real-world-
    // plausible supply (well within Number's safe integer range once
    // divided back down to a normalized amount).
    const balance = BigInt(10_000_000_000) * pow10(18);
    const result = computePoolTvl(tokens, [balance], new Map([["big-token", 1]]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe(10_000_000_000);
  });

  it("preserves sub-cent precision for a high-decimals, low-price token", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "MICRO", decimals: 18, coingeckoId: "micro-token" }];
    // 0.000001 of a token at a fractional price - should not round to 0.
    const balance = pow10(12); // 0.000001 * 10^18
    const result = computePoolTvl(tokens, [balance], new Map([["micro-token", 0.5]]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBeCloseTo(0.0000005, 10);
  });

  it("sums correctly across more than two tokens (not hardcoded to a pair)", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "A", decimals: 18, coingeckoId: "a" },
      { symbol: "B", decimals: 18, coingeckoId: "b" },
      { symbol: "C", decimals: 18, coingeckoId: "c" },
    ];
    const balances = [pow10(18), pow10(18), pow10(18)];
    const prices = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe(6);
  });

  it("an empty token list is a valid $0 pool, not an error", () => {
    const result = computePoolTvl([], [], new Map());
    expect(result).toEqual({ ok: true, tvlUsd: 0 });
  });

  it("accumulates many small per-token contributions exactly, where naive sequential number addition would silently drop them", () => {
    // Classic floating-point summation pitfall: once a running total is
    // large enough, its ULP (gap between adjacent representable doubles)
    // exceeds a small addend, so `runningTotal += small` rounds right
    // back down to `runningTotal` - the addition is a complete no-op.
    // At 1e16 the ULP is exactly 2, so adding 0.5 one token at a time
    // (as the old `tvlUsd += usdValue` loop would) loses every single
    // one of them. Accumulating in BigInt space first and converting to
    // a number only once at the very end doesn't have this failure mode:
    // the *sum* of the 100 small contributions (=$50) is comfortably
    // above the ULP even though no single $0.50 contribution is.
    const LARGE_CONTRIBUTION = 10_000_000_000_000_000; // 1e16, ULP = 2 here
    const SMALL_CONTRIBUTION = 0.5; // below the ULP - lost if added directly to the running total
    const SMALL_TOKEN_COUNT = 100; // exact sum = $50, well above the ULP

    const tokens: PoolTvlToken[] = [
      { symbol: "LARGE", decimals: 0, coingeckoId: "large" },
      ...Array.from({ length: SMALL_TOKEN_COUNT }, (_, i) => ({
        symbol: `S${i}`,
        decimals: 0,
        coingeckoId: `small-${i}`,
      })),
    ];
    const balances = [BigInt(LARGE_CONTRIBUTION), ...Array.from({ length: SMALL_TOKEN_COUNT }, () => BigInt(1))];
    const priceById = new Map<string, number>([
      ["large", 1],
      ...Array.from({ length: SMALL_TOKEN_COUNT }, (_, i) => [`small-${i}`, SMALL_CONTRIBUTION] as const),
    ]);

    const result = computePoolTvl(tokens, balances, priceById);
    if (!result.ok) throw new Error("expected computation to succeed");

    const expectedTotal = LARGE_CONTRIBUTION + SMALL_TOKEN_COUNT * SMALL_CONTRIBUTION;
    expect(result.tvlUsd).toBe(expectedTotal);

    // The old, since-removed implementation's shape - a plain JS-number
    // running total updated one token at a time - proves this test
    // actually distinguishes the fix from the bug: fed the exact same
    // inputs in the exact same order, it silently drops all $50.
    let legacyTotal = 0;
    for (let i = 0; i < tokens.length; i++) {
      const price = priceById.get(tokens[i].coingeckoId)!;
      const normalizedAmount = Number(balances[i]) / 10 ** tokens[i].decimals;
      legacyTotal += normalizedAmount * price;
    }
    expect(legacyTotal).toBe(LARGE_CONTRIBUTION);
    expect(legacyTotal).not.toBe(expectedTotal);
  });

  it("preserves sub-cent precision through multiple tokens without floating-point drift", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
      { symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    ];
    // Deliberately irregular (non-round) balances and prices - the kind of
    // input where naive floating-point accumulation across two tokens
    // tends to drift in the last few digits. Kept comfortably below
    // Number.MAX_SAFE_INTEGER in raw form (unlike the large-balance test
    // above) specifically so this test's own "expected" value, computed
    // with plain JS arithmetic below, isn't itself corrupted by the same
    // precision issue it's trying to check for.
    const balances = [BigInt("123456789"), BigInt("4321098765432")];
    const priceById = new Map([
      ["usd-coin", 1.000123],
      ["weth", 3123.456789],
    ]);

    const result = computePoolTvl(tokens, balances, priceById);
    expect(result.ok).toBe(true);

    const usdcValue = (123456789 / 10 ** 6) * 1.000123;
    const wethValue = (4321098765432 / 10 ** 18) * 3123.456789;
    expect(result.ok && result.tvlUsd).toBeCloseTo(usdcValue + wethValue, 8);
  });

  it("replays a persisted calculation-inputs snapshot and reproduces the exact same TVL", () => {
    // historical_observations.calculation_inputs stores exactly this shape
    // per token (see verifyPoolsOnChain, where it's built from the same
    // tokens/balances/priceById this test reconstructs from). This is the
    // concrete meaning of "replayable": these stored fields alone, fed
    // straight back into computePoolTvl, must reproduce the persisted
    // value - not just be plausible-looking metadata.
    const storedInputs: HistoricalObservationCalculationInput[] = [
      { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, balanceRaw: "1000000000", priceUsd: 1 },
      { symbol: "WETH", coingeckoId: "weth", decimals: 18, balanceRaw: "500000000000000000", priceUsd: 3000 },
    ];

    const tokens: PoolTvlToken[] = storedInputs.map((i) => ({
      symbol: i.symbol,
      decimals: i.decimals,
      coingeckoId: i.coingeckoId,
    }));
    const balances = storedInputs.map((i) => BigInt(i.balanceRaw));
    const priceById = new Map(storedInputs.map((i) => [i.coingeckoId, i.priceUsd]));

    const replayed = computePoolTvl(tokens, balances, priceById);
    expect(replayed).toEqual({ ok: true, tvlUsd: 1000 + 1500 });
  });
});
