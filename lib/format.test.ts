import { describe, expect, it } from "vitest";
import { formatApy, formatDate, formatNumber, formatPercent, formatTokenPrice, formatUsd } from "./format";

describe("formatUsd", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(NaN)).toBe("—");
  });

  it("compacts large values by default", () => {
    expect(formatUsd(1_500_000)).toBe("$1.5M");
  });

  it("shows full precision when compact is disabled", () => {
    expect(formatUsd(1234.5, { compact: false })).toBe("$1,234.50");
  });

  it("formats zero as a real value, not the null placeholder", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("formatTokenPrice", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatTokenPrice(null)).toBe("—");
    expect(formatTokenPrice(undefined)).toBe("—");
    expect(formatTokenPrice(NaN)).toBe("—");
  });

  it("uses 2 decimal places at or above $1", () => {
    expect(formatTokenPrice(1234.5)).toBe("$1,234.50");
  });

  it("uses more precision for sub-dollar prices, not a misleading $0.00", () => {
    // 0.1234 needs all 4 of this tier's fraction digits to represent
    // exactly, unlike a round value like 0.50 which would format
    // identically whether the tier allowed 2 or 4 - a real test of the
    // extra precision, not just a value that happens to round the same.
    expect(formatTokenPrice(0.1234)).toBe("$0.1234");
  });

  it("uses even more precision for sub-cent prices", () => {
    const result = formatTokenPrice(0.00012345);
    expect(result).not.toBe("$0.00");
    expect(result).toBe("$0.000123");
  });

  it("uses maximum precision for extremely small prices", () => {
    const result = formatTokenPrice(0.000000012);
    expect(result).not.toBe("$0.00");
    expect(result).toBe("$0.00000001");
  });

  it("handles negative values via the same tiering as their magnitude", () => {
    expect(formatTokenPrice(-1234.5)).toBe("-$1,234.50");
  });
});

describe("formatNumber", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(NaN)).toBe("—");
  });

  it("compacts large values", () => {
    expect(formatNumber(1_500_000)).toBe("1.5M");
  });
});

describe("formatPercent", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
  });

  it("formats to 2 decimal places with no sign by default", () => {
    expect(formatPercent(12.3456)).toBe("12.35%");
    expect(formatPercent(-12.3456)).toBe("-12.35%");
  });

  it("adds an explicit + sign for positive values only when signed is set", () => {
    expect(formatPercent(12.3, { signed: true })).toBe("+12.30%");
    expect(formatPercent(-12.3, { signed: true })).toBe("-12.30%");
    expect(formatPercent(0, { signed: true })).toBe("0.00%");
  });
});

describe("formatApy", () => {
  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatApy(null)).toBe("—");
    expect(formatApy(undefined)).toBe("—");
    expect(formatApy(NaN)).toBe("—");
  });

  it("formats to 2 decimal places", () => {
    expect(formatApy(5.6789)).toBe("5.68%");
  });
});

describe("formatDate", () => {
  it("returns an em dash for null/undefined", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("renders in UTC regardless of the host machine's local timezone", () => {
    // 23:30 UTC - if this were rendered in a non-UTC local zone (e.g. one
    // several hours behind), the calendar date would roll over to the
    // previous day. Pinning timeZone: "UTC" is exactly what this test
    // guards against regressing.
    const result = formatDate("2026-01-15T23:30:00.000Z");
    expect(result).toContain("Jan 15, 2026");
    expect(result).toContain("UTC");
  });

  it("accepts a Date object as well as a string", () => {
    const result = formatDate(new Date("2026-06-01T12:00:00.000Z"));
    expect(result).toContain("Jun 1, 2026");
  });
});
