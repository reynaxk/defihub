// Shared helper for computing 24h/7d/30d percent change from a time series
// already in hand (chain TVL history is fully backfilled from DefiLlama, so
// this is real computed history, not an estimate). Returns null for any
// window that doesn't have a real data point roughly that far back yet,
// rather than guessing from whatever's closest - a missing 30d change should
// render as "—", not a misleading number computed from 3 days of history.

export interface TvlHistoryPoint {
  timestamp: Date;
  tvl: number | null;
}

export interface TvlChanges {
  latest: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeTvlChanges(history: TvlHistoryPoint[]): TvlChanges {
  const points = history
    .filter((h): h is { timestamp: Date; tvl: number } => h.tvl != null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (points.length === 0) {
    return { latest: null, change24h: null, change7d: null, change30d: null };
  }

  const latestPoint = points[points.length - 1];

  function changeOverDays(days: number): number | null {
    const targetTime = latestPoint.timestamp.getTime() - days * DAY_MS;
    let candidate: { timestamp: Date; tvl: number } | null = null;
    for (const p of points) {
      if (p.timestamp.getTime() <= targetTime) candidate = p;
      else break;
    }
    if (!candidate || candidate.tvl === 0) return null;
    // Require the match to actually be roughly `days` old - otherwise a
    // freshly-synced chain with only 3 days of history would report a "30d
    // change" computed from day 3, which isn't what it claims to be.
    const gapDays = (latestPoint.timestamp.getTime() - candidate.timestamp.getTime()) / DAY_MS;
    if (gapDays < days * 0.7) return null;
    return ((latestPoint.tvl - candidate.tvl) / candidate.tvl) * 100;
  }

  return {
    latest: latestPoint.tvl,
    change24h: changeOverDays(1),
    change7d: changeOverDays(7),
    change30d: changeOverDays(30),
  };
}
