import { describe, expect, it } from "vitest";
import { parseOptionalNumber } from "./query-params";

describe("parseOptionalNumber", () => {
  it("parses a valid numeric string", () => {
    expect(parseOptionalNumber("42.5")).toBe(42.5);
  });

  it("returns undefined for null/undefined/empty string", () => {
    expect(parseOptionalNumber(null)).toBeUndefined();
    expect(parseOptionalNumber(undefined)).toBeUndefined();
    expect(parseOptionalNumber("")).toBeUndefined();
  });

  it("returns undefined for non-numeric garbage instead of NaN", () => {
    // The real bug this guards against: minApy=abc silently matched zero
    // rows in Postgres (NaN sorts above every real value) instead of being
    // ignored like an absent filter.
    expect(parseOptionalNumber("abc")).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    expect(parseOptionalNumber("Infinity")).toBeUndefined();
  });

  it("parses negative numbers and zero", () => {
    expect(parseOptionalNumber("-5")).toBe(-5);
    expect(parseOptionalNumber("0")).toBe(0);
  });
});
