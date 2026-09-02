// Deterministic unit tests for computePoolTvl - the pure "raw on-chain
// balance + decimals + USD price -> pool TVL" math extracted from
// verifyPoolsOnChain specifically so it's testable without a real
// multicall/RPC round-trip. This is DeFiHub's own native TVL calculation
// (see this file's module comment and docs/native-data.md) - price is the
// one external input (CoinGecko, via PriceProvider), everything else -
// reading the balance, normalizing it, valuing it - is computed here.
//
// computePoolTvl's price input and return value are both exact decimal
// strings, never `number` - see verify-pool.ts's own comments on
// priceToExactDecimalString and PoolTvlComputationResult for why. Tests
// below assert against those strings directly rather than converting back
// to `number`, except where a test is deliberately comparing against a
// separately-computed floating-point reference value.
//
// BigInt values use BigInt(...) calls rather than `n`-suffixed literals -
// same convention as lib/indexing/events.ts (BigInt(2000)), since this
// project's TS target doesn't support BigInt literal syntax.
import { describe, expect, it } from "vitest";
import type { HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { attachNativeProvenance, computePoolTvl, priceToExactDecimalString, roundExactDecimal, type PoolTvlToken } from "./verify-pool";
import type { NativePriceOverride } from "./pricing/tvl-integration";

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
      ["token-a", "2"],
      ["token-b", "4"],
    ]);

    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe("400");
  });

  it("handles different decimals correctly (e.g. USDC's 6 vs WETH's 18)", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
      { symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    ];
    // 1,000,000 USDC (raw units) = 1 USDC at 6 decimals; 1 WETH at 18 decimals.
    const balances = [BigInt(1_000_000), pow10(18)];
    const prices = new Map([
      ["usd-coin", "1"],
      ["weth", "3000"],
    ]);

    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe("3001");
  });

  it("a zero balance is a real, valid value - contributes $0, not an error", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "A", decimals: 18, coingeckoId: "token-a" }];
    const result = computePoolTvl(tokens, [BigInt(0)], new Map([["token-a", "5"]]));
    expect(result).toEqual({ ok: true, tvlUsd: "0" });
  });

  it("a failed balance read (null) fails the whole pool, never treated as zero", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "A", decimals: 18, coingeckoId: "token-a" },
      { symbol: "B", decimals: 18, coingeckoId: "token-b" },
    ];
    const result = computePoolTvl(tokens, [pow10(18), null], new Map([["token-a", "1"], ["token-b", "1"]]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("B");
  });

  it("a missing USD price fails the pool rather than substituting a fabricated price", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "UNKNOWN", decimals: 18, coingeckoId: "no-such-id" }];
    const result = computePoolTvl(tokens, [pow10(18)], new Map());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("UNKNOWN");
  });

  it("rejects a malformed price string rather than silently miscomputing", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "A", decimals: 18, coingeckoId: "token-a" }];
    for (const badPrice of ["-5", "NaN", "Infinity", "1e10", "abc", ""]) {
      const result = computePoolTvl(tokens, [pow10(18)], new Map([["token-a", badPrice]]));
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a token whose decimals exceed the calculation scale, rather than silently truncating its raw balance", () => {
    // CALCULATION_SCALE is 30 - no real ERC-20 this app tracks comes close
    // (18 is the practical maximum), but the function's own contract is
    // exact arithmetic or an explicit failure, never silent precision
    // loss for whatever input arrives. 31 decimals can't be rescaled up to
    // 30 by multiplication - the only alternative would be dividing the
    // raw balance back down, discarding real digits while still claiming
    // an "exact" result.
    const tokens: PoolTvlToken[] = [{ symbol: "EXOTIC", decimals: 31, coingeckoId: "exotic-token" }];
    const result = computePoolTvl(tokens, [BigInt("123456789012345678901234567890123")], new Map([["exotic-token", "1"]]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("EXOTIC");
    expect(!result.ok && result.error).toContain("31");
  });

  it("accepts a token whose decimals exactly equal the calculation scale (the boundary case)", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "EDGE", decimals: 30, coingeckoId: "edge-token" }];
    // 1 raw unit at 30 decimals = 1e-30 tokens; priced at $1, the whole
    // pool's TVL from this token is a vanishingly small but real, non-zero
    // number - proving the boundary (decimals === CALCULATION_SCALE)
    // computes rather than being swept into the same rejection as
    // decimals > CALCULATION_SCALE.
    const result = computePoolTvl(tokens, [BigInt(1)], new Map([["edge-token", "1"]]));
    expect(result).toEqual({ ok: true, tvlUsd: "0." + "0".repeat(29) + "1" });
  });

  it("handles a huge balance without overflow or precision collapse", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "BIG", decimals: 18, coingeckoId: "big-token" }];
    // 10 billion tokens at 18 decimals - a genuinely large but real-world-
    // plausible supply (well within Number's safe integer range once
    // divided back down to a normalized amount).
    const balance = BigInt(10_000_000_000) * pow10(18);
    const result = computePoolTvl(tokens, [balance], new Map([["big-token", "1"]]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe("10000000000");
  });

  it("preserves sub-cent precision for a high-decimals, low-price token, exactly - not merely close", () => {
    const tokens: PoolTvlToken[] = [{ symbol: "MICRO", decimals: 18, coingeckoId: "micro-token" }];
    // 0.000001 of a token at a fractional price - should not round to 0.
    const balance = pow10(12); // 0.000001 * 10^18
    const result = computePoolTvl(tokens, [balance], new Map([["micro-token", "0.5"]]));
    expect(result).toEqual({ ok: true, tvlUsd: "0.0000005" });
  });

  it("sums correctly across more than two tokens (not hardcoded to a pair)", () => {
    const tokens: PoolTvlToken[] = [
      { symbol: "A", decimals: 18, coingeckoId: "a" },
      { symbol: "B", decimals: 18, coingeckoId: "b" },
      { symbol: "C", decimals: 18, coingeckoId: "c" },
    ];
    const balances = [pow10(18), pow10(18), pow10(18)];
    const prices = new Map([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    const result = computePoolTvl(tokens, balances, prices);
    expect(result.ok).toBe(true);
    expect(result.ok && result.tvlUsd).toBe("6");
  });

  it("an empty token list is a valid $0 pool, not an error", () => {
    const result = computePoolTvl([], [], new Map());
    expect(result).toEqual({ ok: true, tvlUsd: "0" });
  });

  it("accumulates many small per-token contributions exactly, where naive sequential number addition would silently drop them", () => {
    // Classic floating-point summation pitfall: once a running total is
    // large enough, its ULP (gap between adjacent representable doubles)
    // exceeds a small addend, so `runningTotal += small` rounds right
    // back down to `runningTotal` - the addition is a complete no-op.
    // At 1e16 the ULP is exactly 2, so adding 0.5 one token at a time
    // (as an old `tvlUsd += usdValue` number-based loop would) loses
    // every single one of them. Accumulating in BigInt space and never
    // collapsing to a number at all doesn't have this failure mode: the
    // *sum* of the 100 small contributions (=$50) is comfortably above
    // the ULP even though no single $0.50 contribution is.
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
    const priceById = new Map<string, string>([
      ["large", "1"],
      ...Array.from({ length: SMALL_TOKEN_COUNT }, (_, i) => [`small-${i}`, String(SMALL_CONTRIBUTION)] as const),
    ]);

    const result = computePoolTvl(tokens, balances, priceById);
    if (!result.ok) throw new Error("expected computation to succeed");

    const expectedTotal = LARGE_CONTRIBUTION + SMALL_TOKEN_COUNT * SMALL_CONTRIBUTION; // 10000000000000050
    expect(result.tvlUsd).toBe(String(expectedTotal));

    // The old, since-removed implementation's shape - a plain JS-number
    // running total updated one token at a time - proves this test
    // actually distinguishes the fix from the bug: fed the exact same
    // inputs in the exact same order, it silently drops all $50.
    let legacyTotal = 0;
    for (let i = 0; i < tokens.length; i++) {
      const price = Number(priceById.get(tokens[i].coingeckoId)!);
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
      ["usd-coin", "1.000123"],
      ["weth", "3123.456789"],
    ]);

    const result = computePoolTvl(tokens, balances, priceById);
    expect(result.ok).toBe(true);

    const usdcValue = (123456789 / 10 ** 6) * 1.000123;
    const wethValue = (4321098765432 / 10 ** 18) * 3123.456789;
    // Converting the exact result to Number is deliberate here, and only
    // here: this test's whole point is comparing against a *floating-point*
    // reference computation, which is itself bounded by double precision -
    // production code never does this conversion.
    expect(result.ok && Number(result.tvlUsd)).toBeCloseTo(usdcValue + wethValue, 8);
  });

  it("preserves an exact fractional price (0.1) through the full calculation - a value not exactly representable in binary floating point", () => {
    // 0.1 has no exact binary floating-point representation; the double
    // closest to it is off by about 5.5e-18. priceToExactDecimalString
    // recovers the clean decimal ("0.1", not that double's full binary
    // expansion) via Number.prototype.toString()'s shortest-round-trip
    // guarantee - see its own comment in verify-pool.ts. This test proves
    // that clean "0.1" then survives computePoolTvl's entire exact-BigInt
    // pipeline untouched.
    const tokens: PoolTvlToken[] = [{ symbol: "TOK", decimals: 0, coingeckoId: "tok" }];
    const result = computePoolTvl(tokens, [BigInt(1)], new Map([["tok", priceToExactDecimalString(0.1)]]));
    expect(result).toEqual({ ok: true, tvlUsd: "0.1" });
  });

  it("preserves a TVL above Number.MAX_SAFE_INTEGER with a real fractional component, exactly", () => {
    // 20,000,000,000,000,001 (17 digits, well beyond 2^53 ~= 9.007e15) at
    // a price of exactly $0.5 - the true product, 10000000000000000.5, is
    // both beyond safe-integer range AND has a non-zero fractional part.
    // A number-based implementation can't hold both simultaneously: at
    // this magnitude the double ULP is 4, so Number(20000000000000001n)
    // itself already rounds to 20000000000000000 (nearest multiple of 4),
    // and multiplying by 0.5 collapses to a clean 10000000000000000 -
    // silently losing the entire 50-cent fractional remainder.
    const tokens: PoolTvlToken[] = [{ symbol: "BIG", decimals: 0, coingeckoId: "big" }];
    const balance = BigInt("20000000000000001");
    expect(balance).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const result = computePoolTvl(tokens, [balance], new Map([["big", "0.5"]]));
    expect(result).toEqual({ ok: true, tvlUsd: "10000000000000000.5" });

    // Note: even the literal `10000000000000000.5` in source code would
    // itself already be rounded to 10000000000000000 by the JS parser at
    // this magnitude - there is no way to hold the true value in a
    // `number` at all, which is precisely the point. Comparing against the
    // legacy computation's own (also-rounded) result demonstrates the
    // fractional dollar is gone, without relying on an unrepresentable
    // literal to prove it.
    const legacyResult = (Number(balance) / 10 ** 0) * 0.5;
    expect(legacyResult).toBe(10000000000000000);
    expect(String(legacyResult)).not.toContain(".5");
  });

  it("replays a persisted calculation-inputs snapshot and reproduces the exact same TVL", () => {
    // historical_observations.calculation_inputs stores exactly this shape
    // per token (see verifyPoolsOnChain, where it's built from the same
    // tokens/balances/priceById this test reconstructs from), with priceUsd
    // as the same exact decimal string computePoolTvl itself consumed - no
    // conversion needed to replay it. This is the concrete meaning of
    // "replayable": these stored fields alone, fed straight back into
    // computePoolTvl, must reproduce the persisted value exactly, not just
    // approximately.
    const storedInputs: HistoricalObservationCalculationInput[] = [
      { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, balanceRaw: "1000000000", priceUsd: "1" },
      { symbol: "WETH", coingeckoId: "weth", decimals: 18, balanceRaw: "500000000000000000", priceUsd: "3000" },
    ];

    const tokens: PoolTvlToken[] = storedInputs.map((i) => ({
      symbol: i.symbol,
      decimals: i.decimals,
      coingeckoId: i.coingeckoId!, // this test's own fixtures always set it
    }));
    const balances = storedInputs.map((i) => BigInt(i.balanceRaw));
    const priceById = new Map(storedInputs.map((i) => [i.coingeckoId!, i.priceUsd]));

    const replayed = computePoolTvl(tokens, balances, priceById);
    expect(replayed).toEqual({ ok: true, tvlUsd: "2500" });
  });
});

describe("priceToExactDecimalString", () => {
  it("recovers the clean original decimal for a value not exactly representable in binary (0.1)", () => {
    expect(priceToExactDecimalString(0.1)).toBe("0.1");
  });

  it("passes through a whole number without an unnecessary decimal point", () => {
    expect(priceToExactDecimalString(3000)).toBe("3000");
  });

  it("passes through an ordinary multi-digit decimal price unchanged", () => {
    expect(priceToExactDecimalString(3123.456789)).toBe("3123.456789");
  });

  it("never produces exponential notation for a very small price, where Number.prototype.toString() would", () => {
    const tiny = 0.0000001234; // toString() would render as "1.234e-7"
    expect(tiny.toString()).toContain("e");
    const exact = priceToExactDecimalString(tiny);
    expect(exact).not.toMatch(/e/i);
    expect(exact.startsWith("0.0000001234")).toBe(true);
  });
});

describe("roundExactDecimal", () => {
  it("preserves a sub-cent value at 8 decimals rather than flooring it to 0.00", () => {
    expect(roundExactDecimal("0.0000005", 8)).toBe("0.0000005");
  });

  it("floors a sub-cent value at 2 decimals - by design, matching onchain_verifications' own contract", () => {
    expect(roundExactDecimal("0.0000005", 2)).toBe("0");
  });

  it("rounds half up via exact integer arithmetic, not float rounding", () => {
    expect(roundExactDecimal("1.005", 2)).toBe("1.01");
  });

  it("preserves a value above Number.MAX_SAFE_INTEGER with a fractional component when rescaling", () => {
    expect(roundExactDecimal("10000000000000000.5", 8)).toBe("10000000000000000.5");
  });
});

describe("attachNativeProvenance", () => {
  function calcInput(overrides: Partial<HistoricalObservationCalculationInput> = {}): HistoricalObservationCalculationInput {
    return { symbol: "USDC", coingeckoId: "usd-coin", decimals: 6, balanceRaw: "1000000", priceUsd: "1.00", ...overrides };
  }

  function override(overrides: Partial<NativePriceOverride> = {}): NativePriceOverride {
    return {
      priceUsd: "1.00",
      sources: [],
      observedAt: new Date("2026-08-26T00:00:00.000Z"),
      blockNumber: 19000000,
      blockHash: "0x" + "aa".repeat(32),
      ...overrides,
    };
  }

  it("attaches native provenance to every token when a pool's TVL is fully native - fully native TVL", () => {
    const usdc = calcInput({ symbol: "USDC", coingeckoId: "usd-coin" });
    const weth = calcInput({ symbol: "WETH", coingeckoId: "weth", priceUsd: "2444.40" });
    const overrides = new Map([
      ["usd-coin", override({ priceUsd: "1.00" })],
      ["weth", override({ priceUsd: "2444.40", blockNumber: 19000001 })],
    ]);

    const result = attachNativeProvenance([usdc, weth], overrides);

    expect(result).toHaveLength(2);
    expect(result[0].nativePriceProvenance).toBeDefined();
    expect(result[0].nativePriceProvenance!.blockNumber).toBe(19000000);
    expect(result[0].nativePriceProvenance!.blockHash).toBe("0x" + "aa".repeat(32));
    expect(result[0].nativePriceProvenance!.observedAt).toBe("2026-08-26T00:00:00.000Z");
    expect(result[1].nativePriceProvenance).toBeDefined();
    expect(result[1].nativePriceProvenance!.blockNumber).toBe(19000001);
    // Every other field on each entry is untouched - only the new field is added.
    expect(result[0].priceUsd).toBe("1.00");
    expect(result[0].balanceRaw).toBe("1000000");
    expect(result[1].priceUsd).toBe("2444.40");
  });

  it("attaches native provenance only to the natively-priced token, preserving the other's plain CoinGecko entry untouched - hybrid TVL", () => {
    const usdc = calcInput({ symbol: "USDC", coingeckoId: "usd-coin" });
    const bridgedWeth = calcInput({ symbol: "WETH", coingeckoId: "l2-standard-bridged-weth-base", priceUsd: "2440.00" });
    const overrides = new Map([["usd-coin", override()]]); // bridged WETH's coingeckoId has no override

    const result = attachNativeProvenance([usdc, bridgedWeth], overrides);

    expect(result[0].nativePriceProvenance).toBeDefined();
    expect(result[1].nativePriceProvenance).toBeUndefined();
    // The external entry is byte-for-byte identical to the input - never
    // replaced with fake native metadata.
    expect(result[1]).toEqual(bridgedWeth);
  });

  it("leaves every entry completely unchanged when no token has a native override - fully external TVL", () => {
    const usdt = calcInput({ symbol: "USDT", coingeckoId: "tether" });
    const wbnb = calcInput({ symbol: "WBNB", coingeckoId: "wbnb", priceUsd: "600.00" });

    const result = attachNativeProvenance([usdt, wbnb], new Map());

    expect(result).toEqual([usdt, wbnb]);
    expect(result[0].nativePriceProvenance).toBeUndefined();
    expect(result[1].nativePriceProvenance).toBeUndefined();
  });

  it("preserves the exact source-level identity from the override, not a summarized/lossy copy", () => {
    const usdc = calcInput({ symbol: "USDC", coingeckoId: "usd-coin" });
    const sources: NativePriceOverride["sources"] = [
      {
        sourceKind: "uniswap-v2",
        sourcePoolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
        sourceChainSlug: "ethereum",
        pairedTokenSymbol: "WETH",
        pairedTokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        pairedTokenPriceUsd: "2444.40",
        priceUsd: "1.00",
        liquidityUsd: "20000000",
        reserveRaw: "10026031352833",
        pairedReserveRaw: "4102476795628499120331",
        included: true,
      },
    ];
    const overrides = new Map([["usd-coin", override({ sources })]]);

    const result = attachNativeProvenance([usdc], overrides);

    expect(result[0].nativePriceProvenance!.sources).toEqual(sources);
    expect(result[0].nativePriceProvenance!.sources[0].sourcePoolAddress).toBe("0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc");
  });
});
