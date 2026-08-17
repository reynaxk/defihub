import Link from "next/link";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatPercent, formatUsd } from "@/lib/format";
import type { ProtocolChainBreakdownItem } from "@/lib/database/queries/protocols";

export function ChainDistribution({ chains }: { chains: ProtocolChainBreakdownItem[] }) {
  if (chains.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No per-chain breakdown available yet.</p>;
  }

  const total = chains.reduce((sum, c) => sum + (c.tvl ?? 0), 0);

  return (
    <div className="flex flex-col gap-3">
      {chains.map((chain) => {
        const share = total > 0 && chain.tvl != null ? (chain.tvl / total) * 100 : 0;
        return (
          <div key={chain.chainSlug} className="flex items-center gap-3">
            <Link
              href={`/chain/${chain.chainSlug}`}
              className="flex w-40 shrink-0 items-center gap-2 font-medium hover:text-primary"
            >
              <EntityLogo src={chain.chainLogoUrl} name={chain.chainName} size={20} />
              <span className="truncate">{chain.chainName}</span>
            </Link>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
            </div>
            <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {formatPercent(share)}
            </span>
            <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{formatUsd(chain.tvl)}</span>
          </div>
        );
      })}
    </div>
  );
}
