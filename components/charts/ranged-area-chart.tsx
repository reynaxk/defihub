"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CHART_RANGES, type ChartRangeKey } from "@/lib/charts/ranges";
import { computeChartDisplayState } from "@/lib/charts/chart-display-state";
import { TvlAreaChart, type ChartValueKind, type TvlPoint } from "./tvl-area-chart";

export function RangedAreaChart({
  data,
  height,
  valueKind,
  defaultRange = "30d",
  fetchEndpoint,
  valueField,
  range: controlledRange,
  onRangeChange,
  showRangePicker = true,
}: {
  data: TvlPoint[];
  height?: number;
  valueKind?: ChartValueKind;
  defaultRange?: ChartRangeKey;
  // When set, switching ranges fetches `${fetchEndpoint}?range=` instead of
  // re-filtering `data` client-side - `data` only needs to cover
  // `defaultRange` (the page's own query is bounded to just that much).
  // Without it, this behaves exactly as before: `data` is assumed to
  // already cover the full history and every range is a client-side filter
  // over it (the homepage's global TVL chart, whose own query is already
  // small and day-bucketed, stays on this path).
  fetchEndpoint?: string;
  // Which key to read off each fetched history row (e.g. "tvl", "fees24h",
  // "priceUsd") - required whenever fetchEndpoint is set, since the history
  // routes return the full metrics row, not a pre-mapped {timestamp,value}
  // point.
  valueField?: string;
  // Optional controlled mode - omitted, this behaves exactly as before
  // (its own internal range state). Passed (e.g. by a synchronized
  // multi-chart comparison view driving several charts from one shared
  // control), the chart defers to the caller's state instead.
  range?: ChartRangeKey;
  onRangeChange?: (range: ChartRangeKey) => void;
  // Hides this instance's own picker UI - for a controlled chart whose
  // range is already being chosen by one shared external control.
  showRangePicker?: boolean;
}) {
  const [internalRange, setInternalRange] = useState<ChartRangeKey>(defaultRange);
  const range = controlledRange ?? internalRange;
  const setRange = onRangeChange ?? setInternalRange;
  // A controlled `range` without `onRangeChange` is a caller mistake: clicks
  // would update the unused `internalRange` while `range` (pinned to
  // `controlledRange`) never changes, so the picker would look interactive
  // but silently do nothing. Hide it in that case instead - matches
  // `showRangePicker={false}`'s own read-only-controlled usage.
  const isReadOnlyControlled = controlledRange !== undefined && onRangeChange === undefined;
  // Tracks which range `fetchedData` was fetched for, rather than resetting
  // it to null when the user switches back to `defaultRange` - avoids
  // calling setState synchronously on that early-return path (flagged by
  // the React Compiler's set-state-in-effect check). Falling back to `data`
  // whenever `fetchedRange !== range` covers both the initial render and
  // switching back to the default range, with no reset needed.
  const [fetchedData, setFetchedData] = useState<TvlPoint[] | null>(null);
  const [fetchedRange, setFetchedRange] = useState<ChartRangeKey | null>(null);
  // The cutoff the server actually applied for `fetchedRange` (returned
  // alongside the data) - the source of truth for isPartial below, not the
  // returned data's own latest timestamp, which could disagree with the
  // real applied cutoff if indexing is stale.
  const [fetchedSince, setFetchedSince] = useState<string | null>(null);
  // Which range's fetch most recently failed, rather than a plain boolean -
  // lets `fetchError` below be derived (erroredRange === range) instead of
  // needing an explicit reset when `range` changes, the same trick
  // `isPending` uses. Cleared on the next successful fetch for that range
  // (e.g. a retry), inside the effect's async .then, never synchronously in
  // the effect body itself (the React Compiler's set-state-in-effect check
  // flags that).
  const [erroredRange, setErroredRange] = useState<ChartRangeKey | null>(null);
  const fetchError = erroredRange === range;
  // Bumped to re-run the fetch effect for the same range - the only way to
  // retry, since the effect otherwise only fires on a `range` change.
  const [retryToken, setRetryToken] = useState(0);
  // Derived, not stored: a fetch-requiring range is selected but its data
  // hasn't landed yet. Storing this as its own state would mean setting it
  // synchronously at the top of the effect below, which the React
  // Compiler's set-state-in-effect check (correctly) flags - deriving it
  // from the same fetchedRange/range comparison the render already needs
  // sidesteps that entirely.
  const isPending = Boolean(fetchEndpoint) && range !== defaultRange && fetchedRange !== range && !fetchError;

  useEffect(() => {
    if (!fetchEndpoint || range === defaultRange) return;
    let cancelled = false;
    // fetchEndpoint may already carry its own query string (e.g. the token
    // page's `?chain=` disambiguator) - append with the right separator
    // rather than assuming `?` is always correct.
    const separator = fetchEndpoint.includes("?") ? "&" : "?";
    fetch(`${fetchEndpoint}${separator}range=${range}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`history fetch failed: ${res.status}`))))
      .then((body: { history: Record<string, unknown>[]; since: string | null }) => {
        if (cancelled) return;
        setFetchedData(
          body.history.map((row) => ({
            timestamp: row.timestamp as string,
            value: (valueField ? row[valueField] : row.value) as number | null,
          })),
        );
        setFetchedSince(body.since);
        setFetchedRange(range);
        setErroredRange(null);
      })
      .catch(() => {
        // Deliberately does not touch fetchedData/fetchedRange - a retry
        // (or switching to a range that already loaded successfully) must
        // still be able to fall back to that still-good cached data.
        // computeChartDisplayState is what actually decides what's shown
        // for the *current* range - see its doc comment for why a fetch
        // error there renders an explicit failure state, not silently
        // reused data from a different range.
        if (!cancelled) setErroredRange(range);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchEndpoint, range, defaultRange, valueField, retryToken]);

  const { filtered, isPartial, showError } = useMemo(
    () => computeChartDisplayState({ fetchEndpoint, range, data, fetchedData, fetchedRange, fetchedSince, fetchError }),
    [data, range, fetchEndpoint, fetchedData, fetchedRange, fetchedSince, fetchError],
  );

  const activeLabel = CHART_RANGES.find((r) => r.key === range)?.label;

  return (
    <div>
      {showRangePicker && !isReadOnlyControlled && (
        <div role="group" aria-label="Chart time range" className="mb-3 flex items-center justify-end gap-1">
          {CHART_RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors duration-150",
                range === r.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      {showError ? (
        // Replaces the plot entirely rather than sitting as a small caption
        // above a different range's data - see computeChartDisplayState's
        // doc comment for the bug this fixes (a failed fetch used to leave
        // the *previous* range's chart on screen under the newly-selected
        // range's button, silently misrepresenting which period it covers).
        <div
          className="flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          style={{ height: height ?? 280 }}
        >
          <p>Couldn&apos;t load this range.</p>
          <button
            type="button"
            onClick={() => setRetryToken((n) => n + 1)}
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {isPartial && (
            <p className="mb-2 text-right text-xs text-muted-foreground">
              Showing all available history — not enough data yet for the full {activeLabel} range.
            </p>
          )}
          <div className={cn(isPending && "motion-safe:opacity-60 motion-safe:transition-opacity")}>
            <TvlAreaChart data={filtered} height={height} valueKind={valueKind} />
          </div>
        </>
      )}
    </div>
  );
}
