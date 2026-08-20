import { describe, expect, it } from "vitest";
import { sumKnownValues } from "./aggregate";

describe("sumKnownValues", () => {
  it("sums every value when all are known", () => {
    const { total, isPartial } = sumKnownValues([100, 50, 25]);
    expect(total).toBe(175);
    expect(isPartial).toBe(false);
  });

  it("excludes one null value rather than treating it as 0", () => {
    const { total, isPartial } = sumKnownValues([100, null, 50]);
    expect(total).toBe(150);
    expect(isPartial).toBe(true);
  });

  it("excludes multiple null values", () => {
    const { total, isPartial } = sumKnownValues([100, null, null, 50]);
    expect(total).toBe(150);
    expect(isPartial).toBe(true);
  });

  it("returns a null total, never 0, when every value is unknown", () => {
    const { total, isPartial } = sumKnownValues([null, null, null]);
    expect(total).toBeNull();
    expect(isPartial).toBe(true);
  });

  it("treats a real zero as a known value, not as missing", () => {
    const { total, isPartial } = sumKnownValues([0, 100, 0]);
    expect(total).toBe(100);
    expect(isPartial).toBe(false);
  });

  it("returns a null total and is not partial for an empty set", () => {
    const { total, isPartial } = sumKnownValues([]);
    expect(total).toBeNull();
    expect(isPartial).toBe(false);
  });
});
