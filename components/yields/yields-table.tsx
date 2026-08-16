import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatApy, formatUsd } from "@/lib/format";
import type { getYieldPools } from "@/lib/database/queries/yields";

type YieldPool = Awaited<ReturnType<typeof getYieldPools>>[number];

export function YieldsTable({ pools }: { pools: YieldPool[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pool</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead>Chain</TableHead>
            <TableHead className="text-right">TVL</TableHead>
            <TableHead className="text-right">APY</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pools.map((pool) => (
            <TableRow key={pool.id}>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {pool.symbol}
                  {pool.stablecoin && <Badge variant="secondary">Stable</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {pool.protocolSlug ? (
                  <Link href={`/protocol/${pool.protocolSlug}`} className="flex items-center gap-2 hover:text-foreground">
                    <EntityLogo src={pool.protocolLogoUrl} name={pool.protocolName ?? pool.symbol} size={18} />
                    {pool.protocolName}
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <Link href={`/chain/${pool.chainSlug}`} className="flex items-center gap-2 hover:text-foreground">
                  <EntityLogo src={pool.chainLogoUrl} name={pool.chainName} size={18} />
                  {pool.chainName}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(pool.tvlUsd)}</TableCell>
              <TableCell className="text-right tabular-nums font-medium text-[var(--chart-3)]">
                {formatApy(pool.apy)}
              </TableCell>
            </TableRow>
          ))}
          {pools.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                No pools match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
