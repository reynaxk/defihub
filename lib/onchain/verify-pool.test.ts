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
});
