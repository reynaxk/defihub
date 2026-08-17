import { describe, expect, it } from "vitest";
import { computeTvlChanges } from "./tvl-change";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-08-17T00:00:00Z").getTime();

function pointsAgo(...daysAgoAndTvl: [number, number][]) {
  return daysAgoAndTvl.map(([daysAgo, tvl]) => ({ timestamp: new Date(now - daysAgo * DAY_MS), tvl }));
}

describe("computeTvlChanges", () => {
  it("returns all nulls for empty history", () => {
    expect(computeTvlChanges([])).toEqual({
      latest: null,
      change24h: null,
      change7d: null,
      change30d: null,
    });
  });

  it("computes 24h/7d/30d change from real backfilled history", () => {
    const history = pointsAgo([30, 100], [7, 150], [1, 180], [0, 200]);
    const result = computeTvlChanges(history);
    expect(result.latest).toBe(200);
    expect(result.change24h).toBeCloseTo(((200 - 180) / 180) * 100);
    expect(result.change7d).toBeCloseTo(((200 - 150) / 150) * 100);
    expect(result.change30d).toBeCloseTo(((200 - 100) / 100) * 100);
  });

  it("returns null for a window without a real data point that far back", () => {
    // Only 3 days of real history - asking for 30d change should not
    // silently compute one from day 3 and mislabel it as "30d".
    const history = pointsAgo([3, 100], [1, 110], [0, 120]);
    const result = computeTvlChanges(history);
    expect(result.change30d).toBeNull();
    expect(result.change7d).toBeNull();
    expect(result.change24h).not.toBeNull();
  });

  it("ignores null tvl points and unsorted input", () => {
    const history = [
      { timestamp: new Date(now), tvl: 200 },
      { timestamp: new Date(now - DAY_MS), tvl: null },
      { timestamp: new Date(now - 2 * DAY_MS), tvl: 150 },
    ];
    const result = computeTvlChanges(history);
    expect(result.latest).toBe(200);
    expect(result.change24h).toBeCloseTo(((200 - 150) / 150) * 100);
  });

  it("returns null change when the earlier value was zero", () => {
    const history = pointsAgo([1, 0], [0, 50]);
    expect(computeTvlChanges(history).change24h).toBeNull();
  });
});
