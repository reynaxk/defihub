import { describe, expect, it } from "vitest";
import { computeChartTicks } from "./chart-ticks";

const dayLabel = (timestamp: string) =>
  new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });

describe("computeChartTicks", () => {
  it("returns no duplicate labels for dense same-day hourly data", () => {
    // Reproduces the real bug live-tested against a protocol page: hourly
    // syncs across ~3 real days produced enough points that naive
    // index-based sampling picked several from the same calendar day,
    // rendering "Aug 18" four times.
    const timestamps = Array.from({ length: 72 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 16, 0) + i * 60 * 60 * 1000).toISOString(),
    );
    const ticks = computeChartTicks(timestamps, dayLabel);
    const labels = ticks.map(dayLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("downsamples a long distinct-day range to at most maxTicks", () => {
    const timestamps = Array.from({ length: 90 }, (_, i) =>
      new Date(Date.UTC(2026, 5, 1) + i * 24 * 60 * 60 * 1000).toISOString(),
    );
    const ticks = computeChartTicks(timestamps, dayLabel, 6);
    expect(ticks.length).toBe(6);
    expect(new Set(ticks.map(dayLabel)).size).toBe(6);
  });

  it("returns all points when there are fewer than maxTicks distinct days", () => {
    const timestamps = [
      "2026-08-16T00:00:00.000Z",
      "2026-08-17T00:00:00.000Z",
      "2026-08-18T00:00:00.000Z",
    ];
    const ticks = computeChartTicks(timestamps, dayLabel, 6);
    expect(ticks).toEqual(timestamps);
  });

  it("handles a single timestamp without dividing by zero", () => {
    const ticks = computeChartTicks(["2026-08-18T00:00:00.000Z"], dayLabel, 6);
    expect(ticks).toEqual(["2026-08-18T00:00:00.000Z"]);
  });

  it("handles an empty array", () => {
    expect(computeChartTicks([], dayLabel, 6)).toEqual([]);
  });

  it("keeps the first timestamp of each distinct label", () => {
    const timestamps = [
      "2026-08-18T01:00:00.000Z",
      "2026-08-18T02:00:00.000Z",
      "2026-08-19T01:00:00.000Z",
    ];
    const ticks = computeChartTicks(timestamps, dayLabel, 6);
    expect(ticks).toEqual(["2026-08-18T01:00:00.000Z", "2026-08-19T01:00:00.000Z"]);
  });
});
