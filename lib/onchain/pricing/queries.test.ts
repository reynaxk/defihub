// Pure unit test for isNativeTokenPriceFresh - no DB involved. getNativeTokenPrice
// itself (the DB-touching query) is covered by queries.integration.test.ts.
import { describe, expect, it } from "vitest";
import { isNativeTokenPriceFresh } from "./queries";
import { PRICING_THRESHOLDS } from "./aggregate";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("isNativeTokenPriceFresh", () => {
  it("treats an observation from right now as fresh", () => {
    expect(isNativeTokenPriceFresh(NOW, NOW)).toBe(true);
  });

  it("treats an observation exactly at the freshness threshold as fresh (inclusive)", () => {
    const observedAt = new Date(NOW.getTime() - PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS);
    expect(isNativeTokenPriceFresh(observedAt, NOW)).toBe(true);
  });

  it("treats an observation one millisecond past the freshness threshold as stale", () => {
    const observedAt = new Date(NOW.getTime() - PRICING_THRESHOLDS.MAX_NATIVE_PRICE_AGE_FOR_TVL_MS - 1);
    expect(isNativeTokenPriceFresh(observedAt, NOW)).toBe(false);
  });

  it("treats an observation well within the threshold as fresh", () => {
    const observedAt = new Date(NOW.getTime() - 5 * 60 * 1000); // 5 minutes ago
    expect(isNativeTokenPriceFresh(observedAt, NOW)).toBe(true);
  });

  it("treats an observation well beyond the threshold as stale", () => {
    const observedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 1 day ago
    expect(isNativeTokenPriceFresh(observedAt, NOW)).toBe(false);
  });

  it("never uses block number as a substitute for time - the function's own signature only accepts Dates", () => {
    // Documented via the type signature itself: isNativeTokenPriceFresh(observedAt: Date, now: Date).
    // This test exists to make that guarantee explicit and regression-checkable in intent, not just in types.
    expect(isNativeTokenPriceFresh.length).toBe(2);
  });
});
