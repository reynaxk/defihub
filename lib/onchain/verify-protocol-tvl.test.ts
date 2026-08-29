import { describe, expect, it } from "vitest";
import { computeProtocolTvlUsd, rescaleByPow10 } from "./verify-protocol-tvl";

describe("computeProtocolTvlUsd", () => {
  // Phase 5.8 regression test for a real precision bug caught during the
  // master integration audit: this function used to be
  // `(Number(rawAmount) / 10 ** decimals) * price`, the exact anti-pattern
  // verify-pool.ts's own computePoolTvl was rewritten to avoid. A raw
  // amount this large (~9.5M ETH at 18 decimals, comparable to Lido's real
  // staked-ETH magnitude - one of this app's actual VERIFIED_PROTOCOL_TVLS
  // entries) is far beyond Number.MAX_SAFE_INTEGER (2^53 ~= 9.007e15), so
  // Number(rawAmount) silently loses precision - here it's enough to flip
  // the final cent: the old formula rounds to ...477.56, the exact BigInt
  // calculation rounds to ...477.55, a real, provable one-cent divergence
  // on a ~$22 billion figure, not a theoretical concern.
  it("computes the exact result for a realistic large (Lido-scale) 18-decimal balance - proven to diverge from the old Number()-based formula", () => {
    const rawAmount = BigInt("9500000810178477644138492"); // ~9,500,000.81 ETH raw wei
    const price = 2317.918273645;
    const decimals = 18;

    // The old, buggy formula this fix replaces - kept here only to prove
    // the two genuinely disagree, not as a recommendation.
    const oldBuggyResult = ((Number(rawAmount) / 10 ** decimals) * price).toFixed(2);
    expect(oldBuggyResult).toBe("22020225477.56");

    const result = computeProtocolTvlUsd(rawAmount, decimals, price);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tvlUsd).toBe("22020225477.55499824523572002993364334");

    // The exact result rounds to the genuinely correct cent value - one
    // cent different from what the old Number()-based code would have
    // persisted as ground truth.
    expect(Number(result.tvlUsd) < 22020225477.555).toBe(true);
    expect(oldBuggyResult).not.toBe("22020225477.55");
  });

  it("computes an exact, hand-verifiable result for a small, round balance", () => {
    // 1,000 tokens at 6 decimals ($1.50 each) = exactly $1,500.00 - a
    // simple, deterministic sanity check independent of the large-number
    // precision case above.
    const result = computeProtocolTvlUsd(BigInt(1_000_000_000), 6, 1.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.tvlUsd)).toBeCloseTo(1500, 8);
  });

  it("rejects decimals exceeding this calculation's fixed-point scale rather than silently truncating", () => {
    const result = computeProtocolTvlUsd(BigInt(1), 31, 1.0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("31");
  });

  it("handles a zero raw amount as exactly zero TVL, never an error", () => {
    const result = computeProtocolTvlUsd(BigInt(0), 18, 2500.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.tvlUsd)).toBe(0);
  });
});

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
