import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { StatTile } from "@/components/stats/stat-tile";
import { TvlAreaChart } from "@/components/charts/tvl-area-chart";
import { getTokenByAddress } from "@/lib/database/queries/tokens";
import { isWatchingToken } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatTokenPrice, formatUsd } from "@/lib/format";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  const data = await getTokenByAddress(address);
  if (!data) return {};
  return {
    title: data.token.symbol,
    description: `${data.token.symbol} price and market history on ${data.chain.name}, tracked live on ChainScope.`,
  };
}

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ chain?: string }>;
}) {
  const [{ address }, { chain: chainSlug }, session] = await Promise.all([params, searchParams, auth()]);
  const data = await getTokenByAddress(address, chainSlug);
  if (!data) notFound();

  const { token, chain, history, latest } = data;
  const watching = await isWatchingToken(session?.user?.id, token.id);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <EntityLogo src={token.logoUrl} name={token.symbol} size={40} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {token.symbol}
              {token.name && <span className="ml-2 text-lg font-normal text-muted-foreground">{token.name}</span>}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Link href={`/chain/${chain.slug}`}>
                <Badge variant="outline">{chain.name}</Badge>
              </Link>
            </div>
          </div>
        </div>
        <WatchlistButton isSignedIn={Boolean(session?.user)} initialWatching={watching} tokenId={token.id} />
      </div>

      <p className="mt-4 max-w-3xl break-all font-mono text-xs text-muted-foreground">{token.address}</p>
      {token.coingeckoId && (
        <p className="mt-1 text-xs text-muted-foreground">
          Alert target ID: <code className="font-mono">{token.coingeckoId}</code> — use this on the{" "}
          <Link href="/alerts" className="underline underline-offset-2 hover:text-foreground">
            alerts page
          </Link>{" "}
          to get notified on price moves.
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Price" value={formatTokenPrice(latest?.priceUsd)} />
        <StatTile label="Market cap" value={formatUsd(latest?.marketCap)} />
        <StatTile label="24h volume" value={formatUsd(latest?.volume24h)} />
      </div>

      <div className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Price history</h2>
        <TvlAreaChart
          data={history.map((h) => ({ timestamp: h.timestamp, value: h.priceUsd }))}
          valueKind="tokenPrice"
        />
      </div>
    </div>
  );
}
