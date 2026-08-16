import { describe, expect, it } from "vitest";
import { normalizePagination, totalPages } from "./pagination";

describe("normalizePagination", () => {
  it("defaults to page 1, pageSize 50 when nothing is provided", () => {
    expect(normalizePagination({})).toEqual({ page: 1, pageSize: 50 });
  });

  it("passes through valid values", () => {
    expect(normalizePagination({ page: 3, pageSize: 20 })).toEqual({ page: 3, pageSize: 20 });
  });

  it("clamps pageSize to the max of 100", () => {
    expect(normalizePagination({ pageSize: 500 })).toEqual({ page: 1, pageSize: 100 });
  });

  it("floors non-integer input", () => {
    expect(normalizePagination({ page: 2.9, pageSize: 10.5 })).toEqual({ page: 2, pageSize: 10 });
  });

  it("falls back to defaults for invalid input (NaN, zero, negative)", () => {
    expect(normalizePagination({ page: Number.NaN })).toEqual({ page: 1, pageSize: 50 });
    expect(normalizePagination({ page: 0 })).toEqual({ page: 1, pageSize: 50 });
    expect(normalizePagination({ page: -5 })).toEqual({ page: 1, pageSize: 50 });
    expect(normalizePagination({ pageSize: 0 })).toEqual({ page: 1, pageSize: 50 });
    expect(normalizePagination({ pageSize: -10 })).toEqual({ page: 1, pageSize: 50 });
  });
});

describe("totalPages", () => {
  it("rounds up to cover the remainder", () => {
    expect(totalPages(101, 50)).toBe(3);
    expect(totalPages(100, 50)).toBe(2);
    expect(totalPages(1, 50)).toBe(1);
  });

  it("never returns less than 1, even with zero results", () => {
    expect(totalPages(0, 50)).toBe(1);
  });
});
