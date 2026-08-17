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

  const filtered = useMemo(() => {
    const active = RANGES.find((r) => r.key === range);
    if (!active || active.days == null || data.length === 0) return data;
    // Anchored to the data's own latest point, not wall-clock time - if the
    // last sync is a few hours stale, "24H" should still include it instead
    // of excluding it because Date.now() has already moved past its cutoff.
    const latestTime = Math.max(...data.map((d) => new Date(d.timestamp).getTime()));
    const cutoff = latestTime - active.days * 24 * 60 * 60 * 1000;
    return data.filter((d) => new Date(d.timestamp).getTime() >= cutoff);
  }, [data, range]);

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
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              range === r.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <TvlAreaChart data={filtered} height={height} valueKind={valueKind} />
    </div>
  );
}
