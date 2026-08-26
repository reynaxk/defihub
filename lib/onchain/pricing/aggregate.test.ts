// Pure unit tests for the aggregation/confidence pipeline - no RPC, plain
// constructed candidates.
import { describe, expect, it } from "vitest";
import { aggregatePrices, classifyConfidence, medianPrice, PRICING_THRESHOLDS, type AggregationInput } from "./aggregate";
import type { CandidatePriceSource } from "./types";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function candidate(overrides: Partial<CandidatePriceSource> = {}): CandidatePriceSource {
  return {
    sourceKind: "uniswap-v2",
    sourcePoolAddress: "0xpool",
    sourceChainSlug: "ethereum",
    pairedTokenSymbol: "USDC",
    pairedTokenAddress: "0xusdc",
    pairedTokenPriceUsd: "1.00",
    priceUsd: "2444.40",
    liquidityUsd: "20000000",
    reserveRaw: "4102476795628499120331",
    pairedReserveRaw: "10026031352833",
    ...overrides,
  };
}

function input(overrides: Partial<CandidatePriceSource> = {}, observedAt: Date = NOW): AggregationInput {
  return { candidate: candidate(overrides), observedAt };
}

describe("medianPrice", () => {
  it("returns the single value for one price", () => {
    expect(medianPrice(["100"])).toBe("100");
  });
  it("averages the two middle values for an even-length set", () => {
    expect(medianPrice(["100", "200"])).toBe("150");
  });
  it("returns the true middle value for an odd-length set", () => {
    expect(medianPrice(["100", "300", "200"])).toBe("200");
  });
});

describe("aggregatePrices", () => {
  it("uses the single source directly when there is exactly one", () => {
    const result = aggregatePrices([input()], NOW);
    expect(result.priceUsd).toBe("2444.4");
    expect(result.confidence).not.toBe("INVALID");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].included).toBe(true);
  });

  it("liquidity-weights a liquidity-agreeing multi-source blend rather than a naive average", () => {
    const a = input({ sourcePoolAddress: "0xa", priceUsd: "2440.00", liquidityUsd: "1000000" });
    const b = input({ sourcePoolAddress: "0xb", priceUsd: "2450.00", liquidityUsd: "9000000" });
    const result = aggregatePrices([a, b], NOW);

    expect(result.confidence).toBe("HIGH"); // both included, comfortably liquid, within 100bps of each other
    // Weighted heavily toward the deeper ($9M) source's $2450, not the
    // midpoint ($2445) a naive average would produce.
    const price = Number(result.priceUsd);
    expect(price).toBeGreaterThan(2447);
    expect(price).toBeLessThan(2450.5);
    expect(result.sources.filter((s) => s.included)).toHaveLength(2);
  });

  it("rejects a genuine outlier source and excludes it from the aggregate, with a clear reason", () => {
    const good1 = input({ sourcePoolAddress: "0xa", priceUsd: "2444.00", liquidityUsd: "5000000" });
    const good2 = input({ sourcePoolAddress: "0xb", priceUsd: "2446.00", liquidityUsd: "5000000" });
    // Wildly different from the other two - e.g. a manipulated/broken pool.
    const outlier = input({ sourcePoolAddress: "0xc", priceUsd: "9999.00", liquidityUsd: "5000000" });

    const result = aggregatePrices([good1, good2, outlier], NOW);

    expect(result.confidence).not.toBe("INVALID");
    const included = result.sources.filter((s) => s.included);
    const excluded = result.sources.filter((s) => !s.included);
    expect(included.map((s) => s.sourcePoolAddress).sort()).toEqual(["0xa", "0xb"]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].sourcePoolAddress).toBe("0xc");
    expect(excluded[0].exclusionReason).toMatch(/outlier/);
    // The excluded source never contaminates the final price.
    const price = Number(result.priceUsd);
    expect(price).toBeGreaterThan(2443);
    expect(price).toBeLessThan(2447);
  });

  it("rejects a stale source and excludes it, never blending an old observation in as if fresh", () => {
    const fresh = input({ sourcePoolAddress: "0xa" }, NOW);
    const staleObservedAt = new Date(NOW.getTime() - (PRICING_THRESHOLDS.MAX_SOURCE_AGE_MS + 60_000));
    const stale = input({ sourcePoolAddress: "0xb", priceUsd: "1.00" }, staleObservedAt);

    const result = aggregatePrices([fresh, stale], NOW);

    const included = result.sources.filter((s) => s.included);
    const excluded = result.sources.filter((s) => !s.included);
    expect(included).toHaveLength(1);
    expect(included[0].sourcePoolAddress).toBe("0xa");
    expect(excluded).toHaveLength(1);
    expect(excluded[0].sourcePoolAddress).toBe("0xb");
    expect(excluded[0].exclusionReason).toMatch(/stale/);
  });

  it("returns INVALID confidence and a zero price when there are no sources at all - insufficient sources", () => {
    const result = aggregatePrices([], NOW);
    expect(result.confidence).toBe("INVALID");
    expect(result.priceUsd).toBe("0");
    expect(result.sources).toHaveLength(0);
  });

  it("returns INVALID when every source was excluded (all stale), not a fabricated price from nothing", () => {
    const staleObservedAt = new Date(NOW.getTime() - (PRICING_THRESHOLDS.MAX_SOURCE_AGE_MS + 60_000));
    const result = aggregatePrices([input({}, staleObservedAt)], NOW);
    expect(result.confidence).toBe("INVALID");
    expect(result.priceUsd).toBe("0");
  });

  it("guards against division by zero when the only source has zero liquidity - INVALID, never a thrown error or a fabricated price", () => {
    const result = aggregatePrices([input({ liquidityUsd: "0" })], NOW);
    expect(result.confidence).toBe("INVALID");
    expect(result.priceUsd).toBe("0");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].included).toBe(false);
    expect(result.sources[0].exclusionReason).toMatch(/zero liquidity/);
  });

  it("excludes only the zero-liquidity source and still aggregates normally over the remaining positive-liquidity ones", () => {
    const good = input({ sourcePoolAddress: "0xa", priceUsd: "2444.00", liquidityUsd: "5000000" });
    // Close enough to `good` to clear the outlier-rejection pass on its own
    // price merits - this test is specifically isolating the zero-liquidity
    // guard, not the (already separately tested) outlier-rejection pass.
    const zero = input({ sourcePoolAddress: "0xb", priceUsd: "2445.00", liquidityUsd: "0" });

    const result = aggregatePrices([good, zero], NOW);

    expect(result.confidence).not.toBe("INVALID");
    expect(result.priceUsd).toBe("2444");
    const included = result.sources.filter((s) => s.included);
    const excluded = result.sources.filter((s) => !s.included);
    expect(included).toHaveLength(1);
    expect(included[0].sourcePoolAddress).toBe("0xa");
    expect(excluded).toHaveLength(1);
    expect(excluded[0].sourcePoolAddress).toBe("0xb");
    expect(excluded[0].exclusionReason).toMatch(/zero liquidity/);
  });
});

describe("classifyConfidence", () => {
  it("caps confidence at MEDIUM for an EXTERNAL_FALLBACK price regardless of source count", () => {
    const sources = [candidate({ liquidityUsd: "10000000" }), candidate({ sourcePoolAddress: "0xb", liquidityUsd: "10000000" })];
    expect(classifyConfidence(sources, "EXTERNAL_FALLBACK")).toBe("MEDIUM");
  });

  it("returns LOW when total included liquidity is below the comfortable threshold, even with one source", () => {
    const sources = [candidate({ liquidityUsd: "1000" })];
    expect(classifyConfidence(sources, "ONCHAIN_NATIVE")).toBe("LOW");
  });

  it("returns MEDIUM (never HIGH) for a single, comfortably-liquid, uncorroborated source", () => {
    const sources = [candidate({ liquidityUsd: "20000000" })];
    expect(classifyConfidence(sources, "ONCHAIN_NATIVE")).toBe("MEDIUM");
  });

  it("returns HIGH for two comfortably-liquid sources agreeing tightly", () => {
    const sources = [
      candidate({ sourcePoolAddress: "0xa", priceUsd: "2444.00", liquidityUsd: "10000000" }),
      candidate({ sourcePoolAddress: "0xb", priceUsd: "2445.00", liquidityUsd: "10000000" }),
    ];
    expect(classifyConfidence(sources, "ONCHAIN_NATIVE")).toBe("HIGH");
  });

  it("returns MEDIUM for two comfortably-liquid sources that disagree beyond the HIGH-confidence band", () => {
    const sources = [
      candidate({ sourcePoolAddress: "0xa", priceUsd: "2400.00", liquidityUsd: "10000000" }),
      candidate({ sourcePoolAddress: "0xb", priceUsd: "2490.00", liquidityUsd: "10000000" }),
    ];
    expect(classifyConfidence(sources, "ONCHAIN_NATIVE")).toBe("MEDIUM");
  });

  it("returns INVALID for zero sources", () => {
    expect(classifyConfidence([], "ONCHAIN_NATIVE")).toBe("INVALID");
  });
});
