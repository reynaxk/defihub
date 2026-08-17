"use client";

import { useState } from "react";
import Link from "next/link";
import { EntityLogo } from "@/components/shared/entity-logo";
import { Sparkline } from "@/components/tokens/sparkline";
import { formatPercent, formatTokenPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TokenMover } from "@/lib/database/queries/tokens";

function MoverRow({ mover }: { mover: TokenMover }) {
  return (
    <Link
      href={`/token/${mover.address}?chain=${mover.chainSlug}`}
      className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted"
    >
      <div className="flex items-center gap-2 overflow-hidden">
        <EntityLogo src={mover.logoUrl} name={mover.symbol} size={22} />
        <span className="truncate font-medium">{mover.symbol}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3 tabular-nums">
        <Sparkline points={mover.sparkline} positive={mover.priceChange >= 0} />
        <span className="text-muted-foreground">{formatTokenPrice(mover.priceUsd)}</span>
        <span
          className={cn(
            "w-16 text-right font-medium",
            mover.priceChange >= 0 ? "text-[var(--success-text)]" : "text-destructive",
          )}
        >
          {formatPercent(mover.priceChange, { signed: true })}
        </span>
      </div>
    </Link>
  );
}

export function TopMovers({
  movers24h,
  movers7d,
}: {
  movers24h: { gainers: TokenMover[]; losers: TokenMover[] };
  movers7d: { gainers: TokenMover[]; losers: TokenMover[] };
}) {
  const [window, setWindow] = useState<"24h" | "7d">("24h");
  const active = window === "24h" ? movers24h : movers7d;

  if (movers24h.gainers.length === 0 && movers24h.losers.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <div role="group" aria-label="Time window" className="inline-flex gap-1 rounded-md border border-border p-0.5">
          {(["24h", "7d"] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                window === w
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium text-muted-foreground">Top gainers ({window})</h3>
          <div className="flex flex-col">
            {active.gainers.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">Not enough {window} data yet.</p>
            ) : (
              active.gainers.map((m) => <MoverRow key={`${m.chainSlug}-${m.address}`} mover={m} />)
            )}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium text-muted-foreground">Top losers ({window})</h3>
          <div className="flex flex-col">
            {active.losers.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">Not enough {window} data yet.</p>
            ) : (
              active.losers.map((m) => <MoverRow key={`${m.chainSlug}-${m.address}`} mover={m} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
