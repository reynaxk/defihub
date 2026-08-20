"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { TvlAreaChart, type ChartValueKind, type TvlPoint } from "./tvl-area-chart";

const RANGES = [
  { key: "24h", label: "24H", days: 1 },
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "ALL", days: null },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

export function RangedAreaChart({
  data,
  height,
  valueKind,
  defaultRange = "30d",
}: {
  data: TvlPoint[];
  height?: number;
  valueKind?: ChartValueKind;
  defaultRange?: RangeKey;
}) {
  const [range, setRange] = useState<RangeKey>(defaultRange);

  const { filtered, isPartial } = useMemo(() => {
    const active = RANGES.find((r) => r.key === range);
    if (!active || active.days == null || data.length === 0) return { filtered: data, isPartial: false };
    // Anchored to the data's own latest point, not wall-clock time - if the
    // last sync is a few hours stale, "24H" should still include it instead
    // of excluding it because Date.now() has already moved past its cutoff.
    const timestamps = data.map((d) => new Date(d.timestamp).getTime());
    const latestTime = Math.max(...timestamps);
    const earliestTime = Math.min(...timestamps);
    const cutoff = latestTime - active.days * 24 * 60 * 60 * 1000;
    const filtered = data.filter((d) => new Date(d.timestamp).getTime() >= cutoff);
    // True when the requested window reaches further back than any data
    // actually available - i.e. this isn't a gap in an otherwise-full
    // range, history genuinely doesn't go back that far yet. Silently
    // showing fewer days than the button implies without saying so reads
    // as a data bug rather than the expected "still early" state it is.
    const isPartial = earliestTime > cutoff;
    return { filtered, isPartial };
  }, [data, range]);

  const activeLabel = RANGES.find((r) => r.key === range)?.label;

  return (
    <div>
      <div role="group" aria-label="Chart time range" className="mb-3 flex items-center justify-end gap-1">
        {RANGES.map((r) => (
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
      {isPartial && (
        <p className="mb-2 text-right text-xs text-muted-foreground">
          Showing all available history — not enough data yet for the full {activeLabel} range.
        </p>
      )}
      <TvlAreaChart data={filtered} height={height} valueKind={valueKind} />
    </div>
  );
}
