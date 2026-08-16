import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatTokenPrice, formatUsd } from "@/lib/format";
import type { getTokensList } from "@/lib/database/queries/tokens";

type TokenListItem = Awaited<ReturnType<typeof getTokensList>>[number];

export function TokensTable({ tokens }: { tokens: TokenListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Token</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Market cap</TableHead>
            <TableHead className="text-right">24h volume</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
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
              <TableCell className="text-right tabular-nums">{formatUsd(token.marketCap)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(token.volume24h)}</TableCell>
            </TableRow>
          ))}
          {tokens.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                No tokens match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
