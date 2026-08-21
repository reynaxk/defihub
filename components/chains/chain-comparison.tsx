"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { EntityLogo } from "@/components/shared/entity-logo";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { CHART_RANGES, type ChartRangeKey } from "@/lib/charts/ranges";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ChainComparisonEntry {
  slug: string;
  name: string;
  logoUrl: string | null;
  tvl: number | null;
  change24h: number | null;
  history: { timestamp: string; value: number | null }[];
}

// One shared range control driving every chart below it - RangedAreaChart's
// own range state is opt-in controlled (see its range/onRangeChange props),
// so each small-multiple chart still reuses the exact same fetch/loading/
// error/partial-history handling as every other chart in the app, just
// synchronized to one selection instead of each picking its own.
export function ChainComparisonChart({ chains }: { chains: ChainComparisonEntry[] }) {
  const [range, setRange] = useState<ChartRangeKey>("30d");

  return (
    <div>
      <div role="group" aria-label="Comparison time range" className="mb-4 flex items-center justify-end gap-1">
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {chains.map((chain) => (
          <Card key={chain.slug} className="p-4">
            <Link href={`/chain/${chain.slug}`} className="flex items-center gap-2 hover:text-primary">
              <EntityLogo src={chain.logoUrl} name={chain.name} size={20} />
              <span className="font-medium">{chain.name}</span>
              <span className="ml-auto flex items-baseline gap-2 text-sm">
                <span className="tabular-nums text-foreground">{formatUsd(chain.tvl)}</span>
                <span
                  className={cn(
                    "tabular-nums text-xs",
                    chain.change24h == null
                      ? "text-muted-foreground"
                      : chain.change24h > 0
                        ? "text-[var(--success-text)]"
                        : chain.change24h < 0
                          ? "text-destructive"
                          : "text-muted-foreground",
                  )}
                >
                  {formatPercent(chain.change24h, { signed: true })}
                </span>
              </span>
            </Link>
            <div className="mt-3">
              <RangedAreaChart
                data={chain.history}
                valueKind="usd"
                fetchEndpoint={`/api/chains/${chain.slug}/history`}
                valueField="tvl"
                range={range}
                onRangeChange={setRange}
                showRangePicker={false}
                height={160}
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
