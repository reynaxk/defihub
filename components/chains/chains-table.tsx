import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { PercentChange } from "@/components/shared/percent-change";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { formatPercent, formatUsd } from "@/lib/format";
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
  const totalTvl = chains.reduce((sum, c) => sum + (c.tvl ?? 0), 0);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {watchedChainIds && <TableHead className="w-8" />}
            <TableHead className="w-10">#</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead className="hidden sm:table-cell">Native token</TableHead>
            <TableHead className="text-right">TVL</TableHead>
            <TableHead className="hidden text-right md:table-cell">24h</TableHead>
            <TableHead className="hidden text-right lg:table-cell">% of total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {chains.map((chain, i) => (
            <TableRow key={chain.id}>
              {watchedChainIds && (
                <TableCell>
                  <WatchIconButton
                    target={{ chainId: chain.id }}
                    isSignedIn={isSignedIn}
                    initialWatching={watchedChainIds.has(chain.id)}
                    label={chain.name}
                  />
                </TableCell>
              )}
              <TableCell className="text-muted-foreground">{i + 1}</TableCell>
              <TableCell>
                <Link href={`/chain/${chain.slug}`} className="flex items-center gap-2 font-medium">
                  <EntityLogo src={chain.logoUrl} name={chain.name} size={24} />
                  {chain.name}
                </Link>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">{chain.nativeToken}</TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(chain.tvl)}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">
                <PercentChange value={chain.change24h} />
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {chain.tvl != null && totalTvl > 0 ? formatPercent((chain.tvl / totalTvl) * 100) : "—"}
              </TableCell>
            </TableRow>
          ))}
          {chains.length === 0 && (
            <TableRow>
              <TableCell colSpan={watchedChainIds ? 7 : 6} className="py-10 text-center text-muted-foreground">
                No chains to show yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
