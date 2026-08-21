import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { MetricHeader } from "@/components/stats/metric-header";
import { MetricRow } from "@/components/stats/metric-row";
import { ChangeBadge } from "@/components/shared/change-badge";
import { AnimatedNumber } from "@/components/stats/animated-number";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import {
  getTokenByAddress,
  getTokenChainPresence,
  getTokenPriceChange7d,
} from "@/lib/database/queries/tokens";
import { isWatchingToken } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";

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
    title: `${data.token.symbol} — Price, Market Cap & Chart`,
    description: `${data.token.symbol} price and market history on ${data.chain.name}, tracked live on DeFiHub.`,
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
  const [watching, otherChains, priceChange7d] = await Promise.all([
    isWatchingToken(session?.user?.id, token.id),
    getTokenChainPresence(token.coingeckoId, token.id),
    getTokenPriceChange7d(token.id),
  ]);

  const priceHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.priceUsd }));
  const marketCapHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.marketCap }));
  const historyEndpoint = `/api/tokens/${token.address}/history${chainSlug ? `?chain=${chainSlug}` : ""}`;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-6">
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
              {otherChains.length > 0 && (
                <>
                  <span className="text-xs text-muted-foreground">Also on:</span>
                  {otherChains.map((c) => (
                    <Link key={c.chainSlug} href={`/token/${c.address}?chain=${c.chainSlug}`}>
                      <Badge variant="outline">{c.chainName}</Badge>
                    </Link>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
        <WatchlistButton
          isSignedIn={Boolean(session?.user)}
          initialWatching={watching}
          target={{ tokenId: token.id }}
        />
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

      <div className="mt-6">
        <MetricHeader
          value={latest?.priceUsd != null ? <AnimatedNumber value={latest.priceUsd} format="tokenPrice" /> : "—"}
          label="Price"
          change={<ChangeBadge value={latest?.priceChange24h} period="24H" />}
        />
        <MetricRow
          className="mt-6"
          items={[
            { label: "7D change", value: <ChangeBadge value={priceChange7d} /> },
            { label: "Market cap", value: formatUsd(latest?.marketCap) },
            { label: "24H volume", value: formatUsd(latest?.volume24h) },
          ]}
        />
      </div>

      <Card className="mt-8 p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Price history</h2>
        <RangedAreaChart
          data={priceHistory}
          valueKind="tokenPrice"
          fetchEndpoint={historyEndpoint}
          valueField="priceUsd"
        />
      </Card>

      {marketCapHistory.some((h) => h.value != null) && (
        <Card className="mt-8 p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Market cap history</h2>
          <RangedAreaChart
            data={marketCapHistory}
            valueKind="usd"
            fetchEndpoint={historyEndpoint}
            valueField="marketCap"
          />
        </Card>
      )}
    </div>
  );
}
