import { describe, expect, it } from "vitest";
import { aggregateUsdValues, computeValueUsd } from "./valuation";

describe("computeValueUsd", () => {
  it("multiplies balance by price when a price is tracked", () => {
    expect(computeValueUsd("2.5", 100)).toBe(250);
  });

  it("returns null, never 0, when there is no tracked price", () => {
    expect(computeValueUsd("2.5", null)).toBeNull();
  });

  it("returns a real 0 for a real zero balance that does have a tracked price", () => {
    expect(computeValueUsd("0", 100)).toBe(0);
  });
});

describe("aggregateUsdValues", () => {
  it("sums only the priced values, excluding unpriced ones rather than treating them as 0", () => {
    const { total, isPartial } = aggregateUsdValues([100, null, 50]);
    expect(total).toBe(150);
    expect(isPartial).toBe(true);
  });

  it("is not partial when every held asset is priced", () => {
    const { total, isPartial } = aggregateUsdValues([100, 50]);
    expect(total).toBe(150);
    expect(isPartial).toBe(false);
  });

  it("returns a null total, never $0, when nothing at all is priced", () => {
    const { total, isPartial } = aggregateUsdValues([null, null]);
    expect(total).toBeNull();
    expect(isPartial).toBe(true);
  });

  it("returns a null total and is not partial for an empty set (nothing held)", () => {
    const { total, isPartial } = aggregateUsdValues([]);
    expect(total).toBeNull();
    expect(isPartial).toBe(false);
  });
});
