import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { StatTile } from "@/components/stats/stat-tile";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { TokensTable } from "@/components/tokens/tokens-table";
import { PercentChange } from "@/components/shared/percent-change";
import { getChainBySlug } from "@/lib/database/queries/chains";
import { getTokensList } from "@/lib/database/queries/tokens";
import { isWatchingChain } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatPercent, formatUsd } from "@/lib/format";

const TOP_TOKENS_LIMIT = 8;

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getChainBySlug(slug);
  if (!data) return {};
  return {
    title: data.chain.name,
    description: `${data.chain.name} total value locked and top protocols, tracked live on DeFiHub.`,
  };
}

export default async function ChainDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, session] = await Promise.all([getChainBySlug(slug), auth()]);
  if (!data) notFound();

  const { chain, history, topProtocols, latestTvl, changes } = data;
  const [watching, chainTokens] = await Promise.all([
    isWatchingChain(session?.user?.id, chain.id),
    getTokensList({ chainSlug: chain.slug, sort: "marketCap" }),
  ]);

  // Free to compute from topProtocols (already fetched, up to 50 rows) -
  // no separate query needed for a category-level TVL breakdown.
  const categoryTotals = new Map<string, number>();
  for (const p of topProtocols) {
    if (!p.category || p.tvl == null) continue;
    categoryTotals.set(p.category, (categoryTotals.get(p.category) ?? 0) + p.tvl);
  }
  const categoryBreakdown = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const categoryTotal = categoryBreakdown.reduce((sum, [, tvl]) => sum + tvl, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <EntityLogo src={chain.logoUrl} name={chain.name} size={40} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{chain.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Native token: {chain.nativeToken}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WatchlistButton isSignedIn={Boolean(session?.user)} initialWatching={watching} chainId={chain.id} />
          {chain.explorerUrl && (
            <Link
              href={chain.explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm text-primary hover:underline"
            >
              Explorer
            </Link>
          )}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="TVL"
          value={formatUsd(latestTvl)}
          animate={latestTvl != null ? { value: latestTvl, format: "usd" } : undefined}
        />
        <StatTile label="24h change" customValue={<PercentChange value={changes.change24h} />} />
        <StatTile label="7d change" customValue={<PercentChange value={changes.change7d} />} />
        <StatTile label="30d change" customValue={<PercentChange value={changes.change30d} />} />
        <StatTile
          label="Protocols"
          value={String(topProtocols.length)}
          animate={{ value: topProtocols.length, format: "count" }}
        />
        {/* Chain ID is an identifier, not a magnitude - counting up to it would misleadingly imply it's loading a real quantity */}
        <StatTile label="Chain ID" value={chain.chainId != null ? String(chain.chainId) : "—"} />
      </div>

      <div className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Total value locked</h2>
        <RangedAreaChart data={history.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))} />
      </div>

      {categoryBreakdown.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">TVL by category</h2>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-col gap-3">
              {categoryBreakdown.map(([category, tvl]) => {
                const share = categoryTotal > 0 ? (tvl / categoryTotal) * 100 : 0;
                return (
                  <div key={category} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-sm font-medium">{category}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                      {formatPercent(share)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{formatUsd(tvl)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Top protocols on {chain.name}</h2>
        <ProtocolsTable protocols={topProtocols} />
      </div>

      {chainTokens.length > 0 && (
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold tracking-tight">Tokens on {chain.name}</h2>
            <Link href={`/tokens?chain=${chain.slug}`} className="text-sm text-primary hover:underline">
              View all
            </Link>
          </div>
          <TokensTable tokens={chainTokens.slice(0, TOP_TOKENS_LIMIT)} />
        </div>
      )}
    </div>
  );
}
