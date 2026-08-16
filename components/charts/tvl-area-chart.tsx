"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUsd } from "@/lib/format";

export interface TvlPoint {
  timestamp: string | Date;
  value: number | null;
}

function TooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { value: number; payload: { timestamp: string } }[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="text-muted-foreground">
        {new Date(point.payload.timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </div>
      <div className="mt-0.5 font-medium tabular-nums text-foreground">{formatUsd(point.value, { compact: false })}</div>
    </div>
  );
}

export function TvlAreaChart({ data, height = 280 }: { data: TvlPoint[]; height?: number }) {
  const chartData = data
    .filter((d) => d.value != null)
    .map((d) => ({ timestamp: typeof d.timestamp === "string" ? d.timestamp : d.timestamp.toISOString(), value: d.value }));

  if (chartData.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        Not enough history yet — check back after the next sync.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="tvlFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="timestamp"
          axisLine={false}
          tickLine={false}
          minTickGap={48}
          tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: string) =>
            new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          }
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={64}
          tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          tickFormatter={(value: number) => formatUsd(value)}
        />
        <Tooltip content={<TooltipContent />} cursor={{ stroke: "var(--border)", strokeWidth: 1 }} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#tvlFill)"
          dot={false}
          activeDot={{ r: 4, fill: "var(--chart-1)", stroke: "var(--card)", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
