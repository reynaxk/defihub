"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsd } from "@/lib/format";
import { computeChartTicks } from "@/components/charts/chart-ticks";

// Phase 5.12, Part 2's own explicit requirement: "never display an empty/
// zero chart as though it means zero trading" and "partial day -> visible
// partial/incomplete indicator." A bar per day (not an area, unlike the
// existing TvlAreaChart) specifically because a genuinely new per-point
// visual state (partial vs. complete) needs a per-bar color, not a single
// continuous stroke - not reused from TvlAreaChart, which has no concept
// of a partial point and shouldn't grow one just for this (Part 12: keep
// this narrowly scoped, don't risk regressing the widely-used chart every
// protocol/chain/token page already depends on).
export interface NativeDailyChartPoint {
  day: string | Date;
  value: number;
  isPartial: boolean;
}

function TooltipContent({ active, payload }: { active?: boolean; payload?: { payload: NativeDailyChartPoint & { dayLabel: string } }[] }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="text-muted-foreground">{point.dayLabel}</div>
      <div className="mt-0.5 font-medium tabular-nums text-foreground">{formatUsd(point.value, { compact: false })}</div>
      {point.isPartial && <div className="mt-1 text-amber-600 dark:text-amber-400">Partial — some swaps this day couldn&apos;t be priced</div>}
    </div>
  );
}

export function NativeDailyChart({ data, height = 220 }: { data: NativeDailyChartPoint[]; height?: number }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        No native data yet
      </div>
    );
  }

  const chartData = data.map((d) => ({
    day: typeof d.day === "string" ? d.day : d.day.toISOString(),
    dayLabel: new Date(d.day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    value: d.value,
    isPartial: d.isPartial,
  }));

  const formatTick = (day: string) => new Date(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const tickDays = computeChartTicks(
    chartData.map((d) => d.day),
    formatTick,
  );

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="day" axisLine={false} tickLine={false} minTickGap={48} ticks={tickDays} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} tickFormatter={formatTick} />
          <YAxis axisLine={false} tickLine={false} width={64} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} tickFormatter={(v: number) => formatUsd(v)} />
          <Tooltip content={<TooltipContent />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.isPartial ? "var(--chart-3, #d4a017)" : "var(--chart-1)"} fillOpacity={d.isPartial ? 0.55 : 0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {chartData.some((d) => d.isPartial) && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block size-2 rounded-sm" style={{ background: "var(--chart-3, #d4a017)", opacity: 0.55 }} aria-hidden />
          Lighter bars are partial days — real activity occurred but some swaps couldn&apos;t be priced.
        </p>
      )}
    </div>
  );
}
