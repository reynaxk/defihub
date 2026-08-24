import { CHART_RANGES, type ChartRangeKey } from "./ranges";

export interface ChartDisplayPoint {
  timestamp: string | Date;
  value: number | null;
}

export interface ChartDisplayState {
  filtered: ChartDisplayPoint[];
  isPartial: boolean;
  // True when the currently-selected range failed to load and there is no
  // valid cached data for that exact range - the caller must render an
  // explicit "couldn't load" state instead of `filtered` (which is
  // deliberately empty in this case, never a stand-in for a different
  // range - see the comment below).
  showError: boolean;
}

// Pure decision logic extracted from RangedAreaChart specifically so the
// bug found during the Phase 4 historical-TVL audit is unit-testable
// without a DOM/component-testing setup (this codebase has none): a failed
// fetch for the *currently selected* range (24H/7D/30D/90D/1Y/ALL) used to
// silently fall back to `data` - whatever range was rendered before the
// switch, most commonly the default 30D window passed in from the server -
// while the range picker still showed the newly-selected (failed) range as
// active. The chart plot never went blank and never showed an error; it
// just kept displaying an unrelated period's numbers under a label that no
// longer matched them, with only a small, easy-to-miss caption disclosing
// why. Confirmed live: the per-IP rate limit on the history API routes
// (60 req/min) is realistic to trip during ordinary active exploration -
// switching ranges across even a handful of chain/protocol/token pages in
// a short session - making this a real, reachable "sometimes" bug, not a
// hypothetical one.
//
// The fix: a fetch error for the selected range returns an *empty*
// `filtered` and `showError: true`, so the component renders an explicit
// failure state instead of a mismatched chart. This never fabricates a
// value and never mislabels one range's data as another's.
export function computeChartDisplayState(params: {
  fetchEndpoint: string | undefined;
  range: ChartRangeKey;
  data: ChartDisplayPoint[];
  fetchedData: ChartDisplayPoint[] | null;
  fetchedRange: ChartRangeKey | null;
  fetchedSince: string | null;
  fetchError: boolean;
}): ChartDisplayState {
  const { fetchEndpoint, range, data, fetchedData, fetchedRange, fetchedSince, fetchError } = params;

  if (fetchEndpoint) {
    if (fetchError) {
      return { filtered: [], isPartial: false, showError: true };
    }

    const activeData = fetchedRange === range && fetchedData ? fetchedData : data;
    if (fetchedRange === range && fetchedData) {
      // Bounded server-side to exactly the selected range already.
      // isPartial comes from the cutoff the server actually applied, not
      // recomputed from the returned data's own latest timestamp.
      if (fetchedSince == null || activeData.length === 0) {
        return { filtered: activeData, isPartial: false, showError: false };
      }
      const cutoff = new Date(fetchedSince).getTime();
      const earliestTime = Math.min(...activeData.map((d) => new Date(d.timestamp).getTime()));
      return { filtered: activeData, isPartial: earliestTime > cutoff, showError: false };
    }
    // Not yet fetched for this range (still pending) - showing the last
    // known-good data (dimmed by the caller while pending) rather than
    // guessing at partial-ness for a range that hasn't actually loaded.
    return { filtered: activeData, isPartial: false, showError: false };
  }

  const active = CHART_RANGES.find((r) => r.key === range);
  if (!active || active.days == null || data.length === 0) {
    return { filtered: data, isPartial: false, showError: false };
  }
  // Anchored to the data's own latest point, not wall-clock time - if the
  // last sync is a few hours stale, "24H" should still include it instead
  // of excluding it because Date.now() has already moved past its cutoff.
  const timestamps = data.map((d) => new Date(d.timestamp).getTime());
  const latestTime = Math.max(...timestamps);
  const earliestTime = Math.min(...timestamps);
  const cutoff = latestTime - active.days * 24 * 60 * 60 * 1000;
  const filtered = data.filter((d) => new Date(d.timestamp).getTime() >= cutoff);
  // True when the requested window reaches further back than any data
  // actually available - i.e. this isn't a gap in an otherwise-full range,
  // history genuinely doesn't go back that far yet. Silently showing fewer
  // days than the button implies without saying so reads as a data bug
  // rather than the expected "still early" state it is.
  const isPartial = earliestTime > cutoff;
  return { filtered, isPartial, showError: false };
}
