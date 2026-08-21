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
import { SectionNav } from "@/components/shared/section-nav";
import { DistributionBarList } from "@/components/shared/distribution-bar-list";
import { Card } from "@/components/ui/card";
import { getChainBySlug } from "@/lib/database/queries/chains";
import { getTokensList } from "@/lib/database/queries/tokens";
import {
  getWatchedProtocolIds,
  getWatchedTokenIds,
  isWatchingChain,
} from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";

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
    title: `${data.chain.name} — TVL, Top Protocols & DeFi Analytics`,
    description: `${data.chain.name} total value locked and top protocols, tracked live on DeFiHub.`,
  };
}

export default async function ChainDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, session] = await Promise.all([getChainBySlug(slug), auth()]);
  if (!data) notFound();

  const { chain, history, topProtocols, latestTvl, changes } = data;
  const [watching, topChainTokens] = await Promise.all([
    isWatchingChain(session?.user?.id, chain.id),
    getTokensList({ chainSlug: chain.slug, sort: "marketCap", limit: TOP_TOKENS_LIMIT }),
  ]);

  const [watchedProtocolIds, watchedTokenIds] = await Promise.all([
    getWatchedProtocolIds(session?.user?.id, topProtocols.map((p) => p.id)),
    getWatchedTokenIds(session?.user?.id, topChainTokens.map((t) => t.id)),
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
          <WatchlistButton
            isSignedIn={Boolean(session?.user)}
            initialWatching={watching}
            target={{ chainId: chain.id }}
          />
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

      <SectionNav
        sections={[
          { id: "tvl", label: "TVL" },
          ...(categoryBreakdown.length > 0 ? [{ id: "category-breakdown", label: "Categories" }] : []),
          { id: "top-protocols", label: "Protocols" },
          ...(topChainTokens.length > 0 ? [{ id: "tokens", label: "Tokens" }] : []),
        ]}
      />

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

      <Card id="tvl" className="mt-8 scroll-mt-28 p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Total value locked</h2>
        <RangedAreaChart
          data={history.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))}
          fetchEndpoint={`/api/chains/${chain.slug}/history`}
          valueField="tvl"
        />
      </Card>

      {categoryBreakdown.length > 0 && (
        <div id="category-breakdown" className="mt-8 scroll-mt-28">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">TVL by category</h2>
          <Card className="p-4">
            <DistributionBarList
              items={categoryBreakdown.map(([category, tvl]) => ({ key: category, label: category, value: tvl }))}
              emptyMessage="No category breakdown available yet."
            />
          </Card>
        </div>
      )}

      <div id="top-protocols" className="mt-8 scroll-mt-28">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Top protocols on {chain.name}</h2>
        <ProtocolsTable
          protocols={topProtocols}
          isSignedIn={Boolean(session?.user)}
          watchedProtocolIds={watchedProtocolIds}
        />
      </div>

      {topChainTokens.length > 0 && (
        <div id="tokens" className="mt-8 scroll-mt-28">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold tracking-tight">Tokens on {chain.name}</h2>
            <Link href={`/tokens?chain=${chain.slug}`} className="text-sm text-primary hover:underline">
              View all
            </Link>
          </div>
          <TokensTable
            tokens={topChainTokens}
            isSignedIn={Boolean(session?.user)}
            watchedTokenIds={watchedTokenIds}
          />
        </div>
      )}
    </div>
  );
}
