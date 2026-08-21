import Link from "next/link";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/shared/data-table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { Sparkline } from "@/components/tokens/sparkline";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatPercent, formatUsd } from "@/lib/format";
import { sumKnownValues } from "@/lib/utils/aggregate";
import type { ChainListItem } from "@/lib/database/queries/chains";

export function ChainsTable({
  chains,
  isSignedIn = false,
  watchedChainIds,
  protocolCounts,
  sparklines,
  sort,
}: {
  chains: ChainListItem[];
  isSignedIn?: boolean;
  watchedChainIds?: Set<string>;
  // Both optional: undefined omits the column entirely rather than
  // rendering it empty, so callers that don't need the extra queries
  // (none currently, but mirrors every other optional-column prop in this
  // codebase) aren't forced to fetch them.
  protocolCounts?: Map<string, number>;
  sparklines?: Map<string, number[]>;
  sort?: DataTableSort;
}) {
  // A chain with no synced history has an unknown TVL, not a zero one - `??
  // 0` here would silently understate this total and every other chain's
  // "% of total" share, which is computed against it below.
  const { total: totalTvl, isPartial: isTvlPartial } = sumKnownValues(chains.map((c) => c.tvl));

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
        <Link
          href={`/chain/${chain.slug}`}
          className="flex items-center gap-2 font-medium after:absolute after:inset-0"
        >
          <EntityLogo src={chain.logoUrl} name={chain.name} size={24} />
          {chain.name}
        </Link>
      ),
    },
    {
      key: "nativeToken",
      header: "Native token",
      headClassName: "hidden lg:table-cell",
      cellClassName: "hidden text-muted-foreground lg:table-cell",
      render: (chain) => chain.nativeToken,
    },
    ...(sparklines
      ? [
          {
            key: "sparkline",
            header: "14D",
            headClassName: "hidden sm:table-cell",
            cellClassName: "hidden sm:table-cell",
            render: (chain: ChainListItem) => {
              const points = sparklines.get(chain.id) ?? [];
              // Direction reflects what the sparkline itself shows (the
              // 14-day return, first point to last) rather than change24h -
              // a chain can easily have a red 24h tick inside a rising
              // 14-day line, or vice versa, and coloring by the wrong
              // window looks like a bug even though each number is correct
              // on its own.
              return points.length >= 2 ? (
                <Sparkline points={points} positive={points[points.length - 1] >= points[0]} />
              ) : (
                <span className="text-muted-foreground">—</span>
              );
            },
          } satisfies DataTableColumn<ChainListItem>,
        ]
      : []),
    {
      key: "tvl",
      header: "TVL",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (chain) => formatUsd(chain.tvl),
      sortKey: "tvl",
    },
    {
      key: "change24h",
      header: "24h",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (chain) => <PercentChange value={chain.change24h} />,
      sortKey: "change24h",
    },
    {
      key: "change7d",
      header: "7d",
      headClassName: "hidden text-right md:table-cell",
      cellClassName: "hidden text-right tabular-nums md:table-cell",
      render: (chain) => <PercentChange value={chain.change7d} />,
      sortKey: "change7d",
    },
    ...(protocolCounts
      ? [
          {
            key: "protocols",
            header: "Protocols",
            headClassName: "hidden text-right lg:table-cell",
            cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
            render: (chain: ChainListItem) => {
              const n = protocolCounts.get(chain.id);
              return n != null ? n.toLocaleString("en-US") : "—";
            },
          } satisfies DataTableColumn<ChainListItem>,
        ]
      : []),
    {
      key: "shareOfTotal",
      header: "% of total",
      headClassName: "hidden text-right xl:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground xl:table-cell",
      render: (chain) =>
        // isTvlPartial excluded, not just a non-null total: a total missing
        // one or more chains' TVL is still a real number, but every share
        // computed against it would be inflated by exactly the missing
        // chains' worth - showing a false "100.00%" is worse than "—".
        chain.tvl != null && totalTvl != null && totalTvl > 0 && !isTvlPartial
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
      sort={sort}
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
