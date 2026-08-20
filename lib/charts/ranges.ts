// Shared between the client-side range picker (RangedAreaChart) and the
// server-side history routes, so both agree on exactly what each range key
// means - "30d" is the same cutoff whether computed in the browser (for the
// default-rendered range) or pushed down into a database WHERE clause (for
// every other range, fetched on demand).

export const CHART_RANGES = [
  { key: "24h", label: "24H", days: 1 },
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "ALL", days: null },
] as const;

export type ChartRangeKey = (typeof CHART_RANGES)[number]["key"];

export function isChartRangeKey(value: string | null): value is ChartRangeKey {
  return CHART_RANGES.some((r) => r.key === value);
}

// null means "no lower bound" (the "all" range) - callers push this
// straight into an optional WHERE timestamp >= since clause.
export function sinceForRange(range: ChartRangeKey): Date | null {
  const found = CHART_RANGES.find((r) => r.key === range);
  if (!found || found.days == null) return null;
  return new Date(Date.now() - found.days * 24 * 60 * 60 * 1000);
}
