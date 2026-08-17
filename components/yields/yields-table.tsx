import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchIconButton } from "@/components/shared/watch-icon-button";
import { cn } from "@/lib/utils";
import { formatApy, formatUsd } from "@/lib/format";
import type { getYieldPools } from "@/lib/database/queries/yields";

type YieldPool = Awaited<ReturnType<typeof getYieldPools>>[number];

// Not a judgment about whether a given pool is legitimate - many high APYs
// are real, just typically driven by reward-token emissions or thin
// liquidity rather than organic yield. The threshold only decides when to
// surface that context, not to hide or flag the pool as bad.
const CAUTION_APY = 100;
const HIGH_RISK_APY = 1000;

function ApyCell({ apy }: { apy: number | null }) {
  if (apy == null) return <span className="text-muted-foreground">—</span>;
  const isHighRisk = apy >= HIGH_RISK_APY;
  const isCaution = apy >= CAUTION_APY;

  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {isCaution && (
        <TriangleAlert
          aria-hidden="true"
          className={cn("size-3.5", isHighRisk ? "text-destructive" : "text-amber-500")}
        />
      )}
      <span
        className={cn(
          "font-medium",
          isHighRisk ? "text-destructive" : isCaution ? "text-amber-600 dark:text-amber-500" : "text-[var(--success-text)]",
        )}
        title={
          isCaution
            ? "Very high APY - often driven by reward-token emissions or thin liquidity, not a guaranteed or sustained return."
            : undefined
        }
      >
        {formatApy(apy)}
      </span>
    </span>
  );
}

export function YieldsTable({
  pools,
  isSignedIn = false,
  watchedPoolIds,
}: {
  pools: YieldPool[];
  isSignedIn?: boolean;
  watchedPoolIds?: Set<string>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {watchedPoolIds && <TableHead className="w-8" />}
            <TableHead>Pool</TableHead>
            <TableHead className="hidden sm:table-cell">Protocol</TableHead>
            <TableHead className="hidden md:table-cell">Chain</TableHead>
            <TableHead className="text-right">TVL</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Base APY</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Reward APY</TableHead>
            <TableHead className="text-right">APY</TableHead>
            <TableHead className="hidden text-center xl:table-cell">Risk</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pools.map((pool) => (
            <TableRow key={pool.id}>
              {watchedPoolIds && (
                <TableCell>
                  <WatchIconButton
                    target={{ yieldPoolId: pool.id }}
                    isSignedIn={isSignedIn}
                    initialWatching={watchedPoolIds.has(pool.id)}
                    label={`the ${pool.symbol} pool`}
                  />
                </TableCell>
              )}
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {pool.symbol}
                  {pool.stablecoin && <Badge variant="secondary">Stable</Badge>}
                </div>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {pool.protocolSlug ? (
                  <Link href={`/protocol/${pool.protocolSlug}`} className="flex items-center gap-2 hover:text-foreground">
                    <EntityLogo src={pool.protocolLogoUrl} name={pool.protocolName ?? pool.symbol} size={18} />
                    {pool.protocolName}
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Link href={`/chain/${pool.chainSlug}`} className="flex items-center gap-2 hover:text-foreground">
                  <EntityLogo src={pool.chainLogoUrl} name={pool.chainName} size={18} />
                  {pool.chainName}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(pool.tvlUsd)}</TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {formatApy(pool.apyBase)}
              </TableCell>
              <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                {formatApy(pool.apyReward)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <ApyCell apy={pool.apy} />
              </TableCell>
              <TableCell className="hidden text-center xl:table-cell">
                {pool.ilRisk == null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Badge variant={pool.ilRisk === "yes" ? "destructive" : "outline"}>
                    {pool.ilRisk === "yes" ? "IL risk" : "Low IL"}
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
          {pools.length === 0 && (
            <TableRow>
              <TableCell colSpan={watchedPoolIds ? 9 : 8} className="py-10 text-center text-muted-foreground">
                No pools match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
