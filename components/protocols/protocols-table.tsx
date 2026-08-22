import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/shared/data-table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { EntityBadges } from "@/components/shared/entity-badges";
import { PercentChange } from "@/components/shared/percent-change";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatUsd } from "@/lib/format";
import type { ChainBadge, ProtocolListItem } from "@/lib/database/queries/protocols";

function ChainBadges({ chains }: { chains: ChainBadge[] }) {
  return <EntityBadges items={chains.map((c) => ({ key: c.slug, name: c.name, logoUrl: c.logoUrl }))} groupLabel="Chains" />;
}

export function ProtocolsTable({
  protocols,
  rankOffset = 0,
  isSignedIn = false,
  watchedProtocolIds,
  chainsByProtocolId,
  sort,
}: {
  protocols: ProtocolListItem[];
  rankOffset?: number;
  isSignedIn?: boolean;
  watchedProtocolIds?: Set<string>;
  // Optional: only the /protocols list page fetches this (a dedicated
  // bulk query, see getProtocolChainBadges) - other callers of this table
  // (the homepage's "Top protocols" section) simply don't pass it, and the
  // column is omitted rather than rendered empty.
  chainsByProtocolId?: Map<string, ChainBadge[]>;
  sort?: DataTableSort;
}) {
  const columns: DataTableColumn<ProtocolListItem>[] = [
    {
      key: "rank",
      header: "#",
      headClassName: "w-10",
      cellClassName: "text-muted-foreground",
      render: (_protocol, i) => rankOffset + i + 1,
    },
    {
      key: "protocol",
      header: "Protocol",
      render: (protocol) => (
        <Link
          href={`/protocol/${protocol.slug}`}
          className="flex items-center gap-2 font-medium after:absolute after:inset-0"
        >
          <EntityLogo src={protocol.logoUrl} name={protocol.name} size={24} />
          {protocol.name}
        </Link>
      ),
    },
    {
      key: "category",
      header: "Category",
      headClassName: "hidden sm:table-cell",
      cellClassName: "hidden sm:table-cell",
      render: (protocol) => protocol.category && <Badge variant="secondary">{protocol.category}</Badge>,
    },
    ...(chainsByProtocolId
      ? [
          {
            key: "chains",
            header: "Chains",
            headClassName: "hidden md:table-cell",
            cellClassName: "hidden md:table-cell",
            render: (protocol: ProtocolListItem) => (
              <ChainBadges chains={chainsByProtocolId.get(protocol.id) ?? []} />
            ),
          } satisfies DataTableColumn<ProtocolListItem>,
        ]
      : []),
    {
      key: "tvl",
      header: "TVL",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (protocol) => formatUsd(protocol.tvl),
      sortKey: "tvl",
    },
    {
      key: "change24h",
      header: "24h",
      headClassName: "hidden text-right sm:table-cell",
      cellClassName: "hidden text-right tabular-nums sm:table-cell",
      render: (protocol) => <PercentChange value={protocol.tvlChange1d} />,
      sortKey: "change1d",
    },
    {
      key: "change7d",
      header: "7d",
      headClassName: "hidden text-right md:table-cell",
      cellClassName: "hidden text-right tabular-nums md:table-cell",
      render: (protocol) => <PercentChange value={protocol.tvlChange7d} />,
      sortKey: "change7d",
    },
    {
      key: "volume24h",
      header: "24h Volume",
      headClassName: "hidden text-right md:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground md:table-cell",
      render: (protocol) => formatUsd(protocol.volume24h),
      sortKey: "volume",
    },
    {
      key: "fees24h",
      header: "24h Fees",
      headClassName: "hidden text-right lg:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
      render: (protocol) => formatUsd(protocol.fees24h),
      sortKey: "fees",
    },
    {
      key: "revenue24h",
      header: "24h Revenue",
      headClassName: "hidden text-right lg:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
      render: (protocol) => formatUsd(protocol.revenue24h),
      sortKey: "revenue",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={protocols}
      rowKey={(protocol) => protocol.id}
      emptyMessage="No protocols match these filters yet."
      sort={sort}
      watchColumn={
        watchedProtocolIds
          ? (protocol) => (
              <WatchIconButton
                target={{ protocolId: protocol.id }}
                isSignedIn={isSignedIn}
                initialWatching={watchedProtocolIds.has(protocol.id)}
                label={protocol.name}
              />
            )
          : undefined
      }
    />
  );
}
