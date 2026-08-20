import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatPercent, formatUsd } from "@/lib/format";
import { sumKnownValues } from "@/lib/utils/aggregate";
import type { ChainListItem } from "@/lib/database/queries/chains";

export function ChainsTable({
  chains,
  isSignedIn = false,
  watchedChainIds,
}: {
  chains: ChainListItem[];
  isSignedIn?: boolean;
  watchedChainIds?: Set<string>;
}) {
  // A chain with no synced history has an unknown TVL, not a zero one - `??
  // 0` here would silently understate this total and every other chain's
  // "% of total" share, which is computed against it below.
  const { total: totalTvl } = sumKnownValues(chains.map((c) => c.tvl));

  const columns: DataTableColumn<ChainListItem>[] = [
    {
      key: "rank",
      header: "#",
      headClassName: "w-10",
      cellClassName: "text-muted-foreground",
      render: (_chain, i) => i + 1,
    },
    {
      key: "chain",
      header: "Chain",
      render: (chain) => (
        <Link href={`/chain/${chain.slug}`} className="flex items-center gap-2 font-medium">
          <EntityLogo src={chain.logoUrl} name={chain.name} size={24} />
          {chain.name}
        </Link>
      ),
    },
    {
      key: "nativeToken",
      header: "Native token",
      headClassName: "hidden sm:table-cell",
      cellClassName: "hidden text-muted-foreground sm:table-cell",
      render: (chain) => chain.nativeToken,
    },
    {
      key: "tvl",
      header: "TVL",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (chain) => formatUsd(chain.tvl),
    },
    {
      key: "change24h",
      header: "24h",
      headClassName: "hidden text-right md:table-cell",
      cellClassName: "hidden text-right tabular-nums md:table-cell",
      render: (chain) => <PercentChange value={chain.change24h} />,
    },
    {
      key: "shareOfTotal",
      header: "% of total",
      headClassName: "hidden text-right lg:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
      render: (chain) =>
        chain.tvl != null && totalTvl != null && totalTvl > 0
          ? formatPercent((chain.tvl / totalTvl) * 100)
          : "—",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={chains}
      rowKey={(chain) => chain.id}
      emptyMessage="No chains to show yet."
      watchColumn={
        watchedChainIds
          ? (chain) => (
              <WatchIconButton
                target={{ chainId: chain.id }}
                isSignedIn={isSignedIn}
                initialWatching={watchedChainIds.has(chain.id)}
                label={chain.name}
              />
            )
          : undefined
      }
    />
  );
}
