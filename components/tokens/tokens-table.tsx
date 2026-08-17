import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatPercent, formatTokenPrice, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { getTokensList } from "@/lib/database/queries/tokens";

type TokenListItem = Awaited<ReturnType<typeof getTokensList>>[number];

function PriceChangeCell({ value }: { value: number | null }) {
  if (value == null) return <TableCell className="text-right tabular-nums text-muted-foreground">—</TableCell>;
  return (
    <TableCell
      className={cn("text-right tabular-nums", value >= 0 ? "text-[var(--success-text)]" : "text-destructive")}
    >
      {formatPercent(value, { signed: true })}
    </TableCell>
  );
}

export function TokensTable({
  tokens,
  isSignedIn = false,
  watchedTokenIds,
}: {
  tokens: TokenListItem[];
  isSignedIn?: boolean;
  watchedTokenIds?: Set<string>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {watchedTokenIds && <TableHead className="w-8" />}
            <TableHead>Token</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">24h</TableHead>
            <TableHead className="text-right">Market cap</TableHead>
            <TableHead className="text-right">24h volume</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              {watchedTokenIds && (
                <TableCell>
                  <WatchIconButton
                    target={{ tokenId: token.id }}
                    isSignedIn={isSignedIn}
                    initialWatching={watchedTokenIds.has(token.id)}
                    label={token.symbol}
                  />
                </TableCell>
              )}
              <TableCell className="font-medium">
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
              </TableCell>
              <TableCell>
                <Link href={`/chain/${token.chainSlug}`} className="text-muted-foreground hover:text-foreground">
                  {token.chainName}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatTokenPrice(token.priceUsd)}</TableCell>
              <PriceChangeCell value={token.priceChange24h} />
              <TableCell className="text-right tabular-nums">{formatUsd(token.marketCap)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(token.volume24h)}</TableCell>
            </TableRow>
          ))}
          {tokens.length === 0 && (
            <TableRow>
              <TableCell colSpan={watchedTokenIds ? 7 : 6} className="py-10 text-center text-muted-foreground">
                No tokens match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
