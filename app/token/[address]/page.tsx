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
import { YieldsTable } from "@/components/yields/yields-table";
import {
  getTokenByAddress,
  getTokenChainPresence,
  getTokenPriceChange7d,
} from "@/lib/database/queries/tokens";
import { getYieldPools } from "@/lib/database/queries/yields";
import { getWatchedPoolIds, isWatchingToken } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";

export const revalidate = 300;

// Widely-used tokens (USDT, USDC, WETH...) show up as an underlying asset in
// hundreds of pools - rendering that many rows at once is both a poor list
// to scan and, concretely, made this page's server render take 15-20s in
// dev (confirmed by timing each data-fetch step vs. total request time: the
// fetches summed to under a second, so the cost was in rendering hundreds
// of watch-toggle client-component instances). TVL is a more meaningful
// "relevant" ranking here than raw APY - it surfaces pools that actually
// hold this token at scale rather than small pools with outsized reward-
// driven APYs.
const RELEVANT_POOLS_DISPLAY_LIMIT = 25;

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
  const [watching, otherChains, priceChange7d, relevantPools] = await Promise.all([
    isWatchingToken(session?.user?.id, token.id),
    getTokenChainPresence(token.coingeckoId, token.id),
    getTokenPriceChange7d(token.id),
    // Real "protocol exposure" / "relevant pools": which yield pools list
    // this token's address in their underlyingTokens array (confirmed
    // populated on every pool - see getYieldPools' filter comment). Not a
    // dollar-weighted exposure figure (that would need per-pool token-
    // allocation data this app doesn't have), just which real pools
    // actually involve this token. Sorted by TVL (see
    // RELEVANT_POOLS_DISPLAY_LIMIT above) rather than the default APY sort.
    getYieldPools({ underlyingTokenAddress: token.address, sortBy: "tvl" }),
  ]);
  const displayedPools = relevantPools.slice(0, RELEVANT_POOLS_DISPLAY_LIMIT);
  const watchedPoolIds = await getWatchedPoolIds(
    session?.user?.id,
    displayedPools.map((p) => p.id),
  );

  const priceHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.priceUsd }));
  const marketCapHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.marketCap }));
  const volumeHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.volume24h }));
  const historyEndpoint = `/api/tokens/${token.address}/history${chainSlug ? `?chain=${chainSlug}` : ""}`;

  const exposedProtocols = [...new Map(relevantPools.filter((p) => p.protocolSlug).map((p) => [p.protocolSlug, p])).values()];

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

      {volumeHistory.some((h) => h.value != null) && (
        <Card className="mt-8 p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Volume history</h2>
          <RangedAreaChart data={volumeHistory} valueKind="usd" fetchEndpoint={historyEndpoint} valueField="volume24h" />
        </Card>
      )}

      {exposedProtocols.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Protocol exposure
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Protocols with at least one tracked pool involving {token.symbol}.
          </p>
          <div className="flex flex-wrap gap-2">
            {exposedProtocols.map((p) => (
              <Link key={p.protocolSlug} href={`/protocol/${p.protocolSlug}`}>
                <Badge variant="outline" className="gap-1.5">
                  <EntityLogo src={p.protocolLogoUrl} name={p.protocolName ?? p.protocolSlug!} size={16} />
                  {p.protocolName}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Relevant pools
        </h2>
        {relevantPools.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tracked pools list {token.symbol} as an underlying asset yet.
          </p>
        ) : (
          <>
            {relevantPools.length > RELEVANT_POOLS_DISPLAY_LIMIT && (
              <p className="mb-3 text-xs text-muted-foreground">
                Showing the top {RELEVANT_POOLS_DISPLAY_LIMIT} of {relevantPools.length} pools involving{" "}
                {token.symbol}, ranked by TVL.
              </p>
            )}
            <YieldsTable pools={displayedPools} isSignedIn={Boolean(session?.user)} watchedPoolIds={watchedPoolIds} />
          </>
        )}
      </div>
    </div>
  );
}
