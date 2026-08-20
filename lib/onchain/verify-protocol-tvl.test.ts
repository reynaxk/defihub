import { describe, expect, it } from "vitest";
import { rescaleByPow10 } from "./verify-protocol-tvl";

describe("rescaleByPow10", () => {
  it("returns the amount unchanged for a zero exponent", () => {
    expect(rescaleByPow10(BigInt(123456), 0)).toBe(BigInt(123456));
  });

  it("divides by 10^exponent for a positive exponent", () => {
    // supply/rate both 18 decimals, resolving to an 18-decimal asset -
    // the common case (e.g. rETH's own 1e36-scale product).
    expect(rescaleByPow10(BigInt(1_000_000_000_000_000_000), 18)).toBe(BigInt(1));
  });

  it("multiplies by 10^|exponent| for a negative exponent, instead of throwing", () => {
    // A lower-precision supply/rate pair (6 decimals each, product at 12
    // decimals) resolving to an 18-decimal asset - the scale delta is
    // negative (12 - 18 = -6). BigInt's own `**` throws on a negative
    // exponent, so a naive `/ 10n ** BigInt(exponent)` would crash here.
    expect(rescaleByPow10(BigInt(5), -6)).toBe(BigInt(5_000_000));
  });
});
