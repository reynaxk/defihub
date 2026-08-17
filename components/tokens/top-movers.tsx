import Link from "next/link";
import { EntityLogo } from "@/components/shared/entity-logo";
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
        <span className="text-muted-foreground">{formatTokenPrice(mover.priceUsd)}</span>
        <span
          className={cn(
            "w-16 text-right font-medium",
            mover.priceChange24h >= 0 ? "text-[var(--success-text)]" : "text-destructive",
          )}
        >
          {formatPercent(mover.priceChange24h, { signed: true })}
        </span>
      </div>
    </Link>
  );
}

export function TopMovers({ gainers, losers }: { gainers: TokenMover[]; losers: TokenMover[] }) {
  if (gainers.length === 0 && losers.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-1 text-sm font-medium text-muted-foreground">Top gainers (24h)</h3>
        <div className="flex flex-col">
          {gainers.map((m) => (
            <MoverRow key={`${m.chainSlug}-${m.address}`} mover={m} />
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-1 text-sm font-medium text-muted-foreground">Top losers (24h)</h3>
        <div className="flex flex-col">
          {losers.map((m) => (
            <MoverRow key={`${m.chainSlug}-${m.address}`} mover={m} />
          ))}
        </div>
      </div>
    </div>
  );
}
