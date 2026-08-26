// Pure unit tests for priceSourceForTokens and isNativePriceEligibleForTvl -
// the deterministic policy pieces behind TVL source selection.
// resolveNativePriceOverrides itself is not unit-tested here, matching this
// codebase's established convention that an orchestration function
// composing a DB read (getNativeTokenPrice, covered by
// queries.integration.test.ts) with config isn't directly unit-tested, only
// its pure decision logic is - isNativePriceEligibleForTvl was extracted
// specifically to be that pure decision.
import { describe, expect, it } from "vitest";
import { isNativePriceEligibleForTvl, priceSourceForTokens } from "./tvl-integration";
import { PRICING_THRESHOLDS } from "./aggregate";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("priceSourceForTokens", () => {
  it("tags a pool as onchain-pricing-engine when every one of its tokens was natively priced this run - native price", () => {
    const nativelyPriced = new Set(["usd-coin", "weth"]);
    expect(priceSourceForTokens(["usd-coin", "weth"], nativelyPriced, "coingecko")).toBe("onchain-pricing-engine");
  });

  it("tags a pool as hybrid when only some of its tokens were natively priced this run", () => {
    const nativelyPriced = new Set(["usd-coin"]);
    expect(priceSourceForTokens(["usd-coin", "l2-standard-bridged-weth-base"], nativelyPriced, "coingecko")).toBe(
      "hybrid:onchain-pricing-engine+coingecko",
    );
  });

  it("leaves the external provider's own tag unchanged when none of a pool's tokens were natively priced - fallback price", () => {
    const nativelyPriced = new Set<string>();
    expect(priceSourceForTokens(["tether", "wbnb"], nativelyPriced, "coingecko")).toBe("coingecko");
  });

  it("falls back to the external provider name for a pool with no tokens at all (unreachable in practice, never throws)", () => {
    expect(priceSourceForTokens([], new Set(), "coingecko")).toBe("coingecko");
  });
});

describe("isNativePriceEligibleForTvl", () => {
  it("accepts a fresh HIGH-confidence native price", () => {
    expect(isNativePriceEligibleForTvl("HIGH", NOW, NOW)).toBe(true);
  });

  it("accepts a fresh MEDIUM-confidence native price", () => {
    expect(isNativePriceEligibleForTvl("MEDIUM", NOW, NOW)).toBe(true);
  });

  it("rejects a stale HIGH-confidence native price - falls back to the external price", () => {
    const staleObservedAt = new Date(NOW.getTime() - (PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS + 60_000));
    expect(isNativePriceEligibleForTvl("HIGH", staleObservedAt, NOW)).toBe(false);
  });

  it("rejects a stale MEDIUM-confidence native price - falls back to the external price", () => {
    const staleObservedAt = new Date(NOW.getTime() - (PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS + 60_000));
    expect(isNativePriceEligibleForTvl("MEDIUM", staleObservedAt, NOW)).toBe(false);
  });

  it("rejects a fresh LOW-confidence native price - confidence and freshness are both required, independently", () => {
    expect(isNativePriceEligibleForTvl("LOW", NOW, NOW)).toBe(false);
  });

  it("rejects a fresh INVALID-confidence native price", () => {
    expect(isNativePriceEligibleForTvl("INVALID", NOW, NOW)).toBe(false);
  });

  it("accepts a price observed exactly at the freshness boundary (inclusive)", () => {
    const boundaryObservedAt = new Date(NOW.getTime() - PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS);
    expect(isNativePriceEligibleForTvl("HIGH", boundaryObservedAt, NOW)).toBe(true);
  });

  it("rejects a price observed one millisecond past the freshness boundary", () => {
    const justPastBoundary = new Date(NOW.getTime() - PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS - 1);
    expect(isNativePriceEligibleForTvl("HIGH", justPastBoundary, NOW)).toBe(false);
  });

  it("rejects a HIGH-confidence price observed 1ms in the future - never treated as fresh regardless of confidence", () => {
    const oneMsInFuture = new Date(NOW.getTime() + 1);
    expect(isNativePriceEligibleForTvl("HIGH", oneMsInFuture, NOW)).toBe(false);
  });

  it("a future-dated observation is ineligible the same way a stale one is - the caller falls back to the external price rather than using it as a native override", () => {
    // Same shape as tvl-integration.ts's own resolveNativePriceOverrides
    // eligibility gate (`if (!native || !isNativePriceEligibleForTvl(...)) continue`)
    // - a false result here means that coingeckoId is simply never added to
    // the overrides map, and verify-pool.ts's existing CoinGecko price for
    // it is left completely untouched, exactly as if no native price
    // existed at all.
    const oneMsInFuture = new Date(NOW.getTime() + 1);
    const eligible = isNativePriceEligibleForTvl("HIGH", oneMsInFuture, NOW);
    expect(eligible).toBe(false);
  });
});
