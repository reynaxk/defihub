import Link from "next/link";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { Sparkline } from "@/components/tokens/sparkline";
import { formatUsd } from "@/lib/format";

export interface MarketPulseChain {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  tvl: number | null;
  change24h: number | null;
  sparkline: number[];
}

// Compact per-chain row (logo, TVL, 24h change, sparkline) instead of a
// grid of chain cards - information-dense, scannable, and close to the
// main chart per the spec's "Market Pulse" panel.
export function MarketPulse({ chains }: { chains: MarketPulseChain[] }) {
  return (
    <div className="flex flex-col divide-y divide-border/60">
      {chains.map((chain) => (
        <Link
          key={chain.id}
          href={`/chain/${chain.slug}`}
          className="-mx-2 flex items-center justify-between gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50"
        >
          <div className="flex min-w-0 items-center gap-2">
            <EntityLogo src={chain.logoUrl} name={chain.name} size={20} />
            <span className="truncate text-sm font-medium">{chain.name}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 tabular-nums">
            {chain.sparkline.length >= 2 && (
              <Sparkline points={chain.sparkline} positive={(chain.change24h ?? 0) >= 0} />
            )}
            <span className="w-16 text-right text-sm text-muted-foreground">{formatUsd(chain.tvl)}</span>
            <PercentChange value={chain.change24h} className="w-14 text-right text-sm font-medium" />
          </div>
        </Link>
      ))}
    </div>
  );
}
