import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatTokenPrice, formatUsd } from "@/lib/format";
import type { getTokensList } from "@/lib/database/queries/tokens";

type TokenListItem = Awaited<ReturnType<typeof getTokensList>>[number];

export function TokensTable({
  tokens,
  isSignedIn = false,
  watchedTokenIds,
}: {
  tokens: TokenListItem[];
  isSignedIn?: boolean;
  watchedTokenIds?: Set<string>;
}) {
  const columns: DataTableColumn<TokenListItem>[] = [
    {
      key: "token",
      header: "Token",
      cellClassName: "font-medium",
      render: (token) => (
        <Link
          href={`/token/${token.address}?chain=${token.chainSlug}`}
          className="flex items-center gap-2 hover:text-foreground"
        >
          <EntityLogo src={token.logoUrl} name={token.symbol} size={22} />
          <div>
            <div>{token.symbol}</div>
            {token.name && <div className="text-xs font-normal text-muted-foreground">{token.name}</div>}
          </div>
        </Link>
      ),
    },
    {
      key: "chain",
      header: "Chain",
      render: (token) => (
        <Link href={`/chain/${token.chainSlug}`} className="text-muted-foreground hover:text-foreground">
          {token.chainName}
        </Link>
      ),
    },
    {
      key: "price",
      header: "Price",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (token) => formatTokenPrice(token.priceUsd),
    },
    {
      key: "change24h",
      header: "24h",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (token) => <PercentChange value={token.priceChange24h} />,
    },
    {
      key: "marketCap",
      header: "Market cap",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (token) => formatUsd(token.marketCap),
    },
    {
      key: "volume24h",
      header: "24h volume",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (token) => formatUsd(token.volume24h),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={tokens}
      rowKey={(token) => token.id}
      emptyMessage="No tokens match these filters."
      watchColumn={
        watchedTokenIds
          ? (token) => (
              <WatchIconButton
                target={{ tokenId: token.id }}
                isSignedIn={isSignedIn}
                initialWatching={watchedTokenIds.has(token.id)}
                label={token.symbol}
              />
            )
          : undefined
      }
    />
  );
}
