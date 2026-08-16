import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { StatTile } from "@/components/stats/stat-tile";
import { TvlAreaChart } from "@/components/charts/tvl-area-chart";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { getChainBySlug } from "@/lib/database/queries/chains";
import { isWatchingChain } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";

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
    description: `${data.chain.name} total value locked and top protocols, tracked live on ChainScope.`,
  };
}

export default async function ChainDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, session] = await Promise.all([getChainBySlug(slug), auth()]);
  if (!data) notFound();

  const { chain, history, topProtocols, latestTvl } = data;
  const watching = await isWatchingChain(session?.user?.id, chain.id);

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

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="TVL" value={formatUsd(latestTvl)} />
        <StatTile label="Protocols" value={String(topProtocols.length)} />
        <StatTile label="Chain ID" value={chain.chainId != null ? String(chain.chainId) : "—"} />
      </div>

      <div className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Total value locked</h2>
        <TvlAreaChart data={history.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))} />
      </div>

      <div className="mt-8">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Top protocols on {chain.name}</h2>
        <ProtocolsTable protocols={topProtocols} />
      </div>
    </div>
  );
}
