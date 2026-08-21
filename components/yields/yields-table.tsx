import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/shared/data-table";
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
  sort,
}: {
  pools: YieldPool[];
  isSignedIn?: boolean;
  watchedPoolIds?: Set<string>;
  sort?: DataTableSort;
}) {
  const columns: DataTableColumn<YieldPool>[] = [
    {
      key: "pool",
      header: "Pool",
      cellClassName: "font-medium",
      render: (pool) => (
        <div className="flex items-center gap-2">
          {pool.symbol}
          {pool.stablecoin && <Badge variant="secondary">Stable</Badge>}
        </div>
      ),
    },
    {
      key: "protocol",
      header: "Protocol",
      headClassName: "hidden sm:table-cell",
      cellClassName: "hidden text-muted-foreground sm:table-cell",
      render: (pool) =>
        pool.protocolSlug ? (
          <Link href={`/protocol/${pool.protocolSlug}`} className="flex items-center gap-2 hover:text-foreground">
            <EntityLogo src={pool.protocolLogoUrl} name={pool.protocolName ?? pool.symbol} size={18} />
            {pool.protocolName}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      key: "chain",
      header: "Chain",
      headClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      render: (pool) => (
        <Link href={`/chain/${pool.chainSlug}`} className="flex items-center gap-2 hover:text-foreground">
          <EntityLogo src={pool.chainLogoUrl} name={pool.chainName} size={18} />
          {pool.chainName}
        </Link>
      ),
    },
    {
      key: "tvl",
      header: "TVL",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (pool) => formatUsd(pool.tvlUsd),
      sortKey: "tvl",
    },
    {
      key: "apyBase",
      header: "Base APY",
      headClassName: "hidden text-right lg:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
      render: (pool) => formatApy(pool.apyBase),
    },
    {
      key: "apyReward",
      header: "Reward APY",
      headClassName: "hidden text-right lg:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground lg:table-cell",
      render: (pool) => formatApy(pool.apyReward),
    },
    {
      key: "apy",
      header: "APY",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (pool) => <ApyCell apy={pool.apy} />,
      sortKey: "apy",
    },
    {
      key: "risk",
      header: "Risk",
      headClassName: "hidden text-center xl:table-cell",
      cellClassName: "hidden text-center xl:table-cell",
      render: (pool) =>
        pool.ilRisk == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Badge variant={pool.ilRisk === "yes" ? "destructive" : "outline"}>
            {pool.ilRisk === "yes" ? "IL risk" : "Low IL"}
          </Badge>
        ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={pools}
      rowKey={(pool) => pool.id}
      emptyMessage="No pools match these filters."
      sort={sort}
      watchColumn={
        watchedPoolIds
          ? (pool) => (
              <WatchIconButton
                target={{ yieldPoolId: pool.id }}
                isSignedIn={isSignedIn}
                initialWatching={watchedPoolIds.has(pool.id)}
                label={`the ${pool.symbol} pool`}
              />
            )
          : undefined
      }
    />
  );
}
