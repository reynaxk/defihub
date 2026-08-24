// Regression coverage for the Phase 4 historical-TVL audit's confirmed bug:
// a failed range-history fetch used to silently fall back to showing a
// *different* range's data under the newly-selected (failed) range's
// button - reproduced live via the chain-history API route's per-IP rate
// limit, which is realistic to trip during ordinary active browsing, not
// just abuse. See this module's own doc comment for the full root-cause
// writeup.
import { describe, expect, it } from "vitest";
import { computeChartDisplayState, type ChartDisplayPoint } from "./chart-display-state";

const DEFAULT_DATA: ChartDisplayPoint[] = [
  { timestamp: "2026-01-01T00:00:00.000Z", value: 100 },
  { timestamp: "2026-01-02T00:00:00.000Z", value: 200 },
];

describe("computeChartDisplayState - fetch path (fetchEndpoint set)", () => {
  it("the bug: a fetch error for the selected range never falls back to a different range's data", () => {
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "90d",
      data: DEFAULT_DATA,
      // Simulates a previously-successful 30d fetch still cached in state
      // when the user switched to 90d and *that* fetch failed.
      fetchedData: [{ timestamp: "2026-01-05T00:00:00.000Z", value: 999 }],
      fetchedRange: "30d",
      fetchedSince: null,
      fetchError: true,
    });

    expect(result.showError).toBe(true);
    expect(result.filtered).toEqual([]);
    // Neither the stale 30d fetchedData nor the original default `data`
    // may be shown under the 90d button - that's exactly the bug.
    expect(result.filtered).not.toEqual(DEFAULT_DATA);
    expect(result.isPartial).toBe(false);
  });

  it("a fetch error with no prior successful fetch at all still shows the error state, not the default data", () => {
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "90d",
      data: DEFAULT_DATA,
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      fetchError: true,
    });

    expect(result.showError).toBe(true);
    expect(result.filtered).toEqual([]);
  });

  it("a successful fetch for the current range is shown, with isPartial false when data reaches the cutoff", () => {
    const fetched: ChartDisplayPoint[] = [
      { timestamp: "2026-01-01T00:00:00.000Z", value: 10 },
      { timestamp: "2026-01-02T00:00:00.000Z", value: 20 },
    ];
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "90d",
      data: DEFAULT_DATA,
      fetchedData: fetched,
      fetchedRange: "90d",
      fetchedSince: "2026-01-01T00:00:00.000Z",
      fetchError: false,
    });

    expect(result.showError).toBe(false);
    expect(result.filtered).toEqual(fetched);
    expect(result.isPartial).toBe(false);
  });

  it("flags isPartial when the earliest returned point is after the server's applied cutoff", () => {
    const fetched: ChartDisplayPoint[] = [{ timestamp: "2026-01-05T00:00:00.000Z", value: 10 }];
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "90d",
      data: DEFAULT_DATA,
      fetchedData: fetched,
      fetchedRange: "90d",
      // Server was asked for data back to Jan 1 but the earliest real row
      // is Jan 5 - history genuinely doesn't go back the full 90d yet.
      fetchedSince: "2026-01-01T00:00:00.000Z",
      fetchError: false,
    });

    expect(result.isPartial).toBe(true);
    expect(result.showError).toBe(false);
  });

  it("an empty successful result is a real empty state, not an error and not isPartial", () => {
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "24h",
      data: DEFAULT_DATA,
      fetchedData: [],
      fetchedRange: "24h",
      fetchedSince: "2026-01-01T00:00:00.000Z",
      fetchError: false,
    });

    expect(result.filtered).toEqual([]);
    expect(result.isPartial).toBe(false);
    expect(result.showError).toBe(false);
  });

  it("a still-pending fetch (not yet errored) shows the last known-good data, not an error", () => {
    const result = computeChartDisplayState({
      fetchEndpoint: "/api/x/history",
      range: "90d",
      data: DEFAULT_DATA,
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      fetchError: false,
    });

    expect(result.showError).toBe(false);
    expect(result.filtered).toEqual(DEFAULT_DATA);
    expect(result.isPartial).toBe(false);
  });
});

describe("computeChartDisplayState - client-filter path (no fetchEndpoint)", () => {
  it("filters to the requested day range and never sets showError", () => {
    const data: ChartDisplayPoint[] = [
      { timestamp: "2026-01-01T00:00:00.000Z", value: 1 },
      { timestamp: "2026-01-05T00:00:00.000Z", value: 2 },
      { timestamp: "2026-01-10T00:00:00.000Z", value: 3 },
    ];
    const result = computeChartDisplayState({
      fetchEndpoint: undefined,
      range: "7d",
      data,
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      // Even a stale/irrelevant fetchError from a previous fetchEndpoint
      // usage must not leak into this path - there is no fetch here at all.
      fetchError: true,
    });

    expect(result.showError).toBe(false);
    expect(result.filtered.map((d) => d.value)).toEqual([2, 3]);
  });

  it("does not crash on an empty data array (no Math.min/max over an empty list)", () => {
    const result = computeChartDisplayState({
      fetchEndpoint: undefined,
      range: "30d",
      data: [],
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      fetchError: false,
    });

    expect(result.filtered).toEqual([]);
    expect(result.isPartial).toBe(false);
    expect(result.showError).toBe(false);
  });

  it("the ALL range (no day cutoff) returns every point unfiltered", () => {
    const data: ChartDisplayPoint[] = [
      { timestamp: "2020-01-01T00:00:00.000Z", value: 1 },
      { timestamp: "2026-01-01T00:00:00.000Z", value: 2 },
    ];
    const result = computeChartDisplayState({
      fetchEndpoint: undefined,
      range: "all",
      data,
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      fetchError: false,
    });

    expect(result.filtered).toEqual(data);
    expect(result.isPartial).toBe(false);
  });

  it("flags isPartial when history doesn't reach as far back as the requested range", () => {
    const data: ChartDisplayPoint[] = [
      { timestamp: "2026-01-08T00:00:00.000Z", value: 1 },
      { timestamp: "2026-01-10T00:00:00.000Z", value: 2 },
    ];
    // 30d range requested, but the earliest point is only ~2 days before
    // the latest one.
    const result = computeChartDisplayState({
      fetchEndpoint: undefined,
      range: "30d",
      data,
      fetchedData: null,
      fetchedRange: null,
      fetchedSince: null,
      fetchError: false,
    });

    expect(result.isPartial).toBe(true);
    expect(result.filtered).toHaveLength(2);
  });
});
