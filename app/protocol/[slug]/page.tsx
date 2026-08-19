import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { StatTile } from "@/components/stats/stat-tile";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { AiSummaryCard } from "@/components/protocols/ai-summary-card";
import { OnchainVerificationCard } from "@/components/protocols/onchain-verification-card";
import { ChainDistribution } from "@/components/protocols/chain-distribution";
import { PercentChange } from "@/components/shared/percent-change";
import { YieldsTable } from "@/components/yields/yields-table";
import { getProtocolBySlug, getProtocolChainBreakdown } from "@/lib/database/queries/protocols";
import { getYieldPools } from "@/lib/database/queries/yields";
import { getWatchedPoolIds, isWatchingProtocol } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatDate, formatUsd } from "@/lib/format";
import { getCachedProtocolSummary, isAiSummaryAvailable } from "@/lib/ai/protocol-summary";
import { getVerificationsForProtocol } from "@/lib/onchain/verify-pool";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getProtocolBySlug(slug);
  if (!data) return {};
  return {
    title: `${data.protocol.name} — TVL, Fees, Revenue & DeFi Analytics`,
    description:
      data.protocol.description ??
      `${data.protocol.name} TVL, fees, revenue and volume, tracked live on DeFiHub.`,
  };
}

function MetricTab({
  label,
  latestValue,
  history,
  metric,
}: {
  label: string;
  latestValue: number | null | undefined;
  history: { timestamp: string; value: number | null }[];
  metric: string;
}) {
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-1 sm:w-48">
        <StatTile
          label={`Latest 24h ${metric}`}
          value={formatUsd(latestValue)}
          animate={latestValue != null ? { value: latestValue, format: "usd" } : undefined}
        />
      </div>
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{label} history</h2>
        <RangedAreaChart data={history} />
      </Card>
    </div>
  );
}

export default async function ProtocolDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, session] = await Promise.all([getProtocolBySlug(slug), auth()]);
  if (!data) notFound();

  const { protocol, chains, history, latest } = data;
  const [watching, cachedSummary, verifications, chainBreakdown, protocolYields] = await Promise.all([
    isWatchingProtocol(session?.user?.id, protocol.id),
    getCachedProtocolSummary(protocol.id, latest?.tvl ?? null),
    getVerificationsForProtocol(protocol.id),
    getProtocolChainBreakdown(protocol.id),
    getYieldPools({ protocolSlug: protocol.slug }),
  ]);

  const watchedPoolIds = await getWatchedPoolIds(
    session?.user?.id,
    protocolYields.map((p) => p.id),
  );

  const tvlHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.tvl }));
  const feesHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.fees24h }));
  const revenueHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.revenue24h }));
  const volumeHistory = history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.volume24h }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <EntityLogo src={protocol.logoUrl} name={protocol.name} size={40} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{protocol.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {protocol.category && <Badge variant="secondary">{protocol.category}</Badge>}
              {chains.map((chain) => (
                <Link key={chain.id} href={`/chain/${chain.slug}`}>
                  <Badge variant="outline">{chain.name}</Badge>
                </Link>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WatchlistButton isSignedIn={Boolean(session?.user)} initialWatching={watching} protocolId={protocol.id} />
          {protocol.website && (
            <Link
              href={protocol.website}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Website <ExternalLink className="size-3.5" />
            </Link>
          )}
        </div>
      </div>

      {protocol.description && <p className="mt-4 max-w-3xl text-muted-foreground">{protocol.description}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="TVL"
          value={formatUsd(latest?.tvl)}
          animate={latest?.tvl != null ? { value: latest.tvl, format: "usd" } : undefined}
        />
        <StatTile label="24h change" customValue={<PercentChange value={latest?.tvlChange1d} />} />
        <StatTile label="7d change" customValue={<PercentChange value={latest?.tvlChange7d} />} />
        <StatTile
          label="24h Volume"
          value={formatUsd(latest?.volume24h)}
          animate={latest?.volume24h != null ? { value: latest.volume24h, format: "usd" } : undefined}
        />
        <StatTile
          label="24h Fees"
          value={formatUsd(latest?.fees24h)}
          animate={latest?.fees24h != null ? { value: latest.fees24h, format: "usd" } : undefined}
        />
        <StatTile
          label="24h Revenue"
          value={formatUsd(latest?.revenue24h)}
          animate={latest?.revenue24h != null ? { value: latest.revenue24h, format: "usd" } : undefined}
        />
      </div>

      <Tabs defaultValue="overview" className="mt-8">
        <div className="relative">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tvl">TVL</TabsTrigger>
            <TabsTrigger value="fees">Fees</TabsTrigger>
            <TabsTrigger value="revenue">Revenue</TabsTrigger>
            <TabsTrigger value="volume">Volume</TabsTrigger>
            <TabsTrigger value="chains">Chains</TabsTrigger>
            <TabsTrigger value="yields">Yields</TabsTrigger>
          </TabsList>
          {/* Hints that the tab bar scrolls (no visible affordance otherwise) - only
              matters on narrow viewports where all 7 tabs don't fit, so hidden at sm+. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 right-0 h-full w-8 bg-gradient-to-l from-background to-transparent sm:hidden"
          />
        </div>

        <TabsContent value="overview" className="mt-4">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Total value locked</h2>
            <RangedAreaChart data={tvlHistory} />
          </Card>
          <OnchainVerificationCard verifications={verifications} />
          <AiSummaryCard
            slug={protocol.slug}
            isSignedIn={Boolean(session?.user)}
            aiAvailable={isAiSummaryAvailable()}
            initialSummary={
              cachedSummary ? { ...cachedSummary, createdAt: cachedSummary.createdAt.toISOString() } : null
            }
          />
          {latest && (
            <p className="mt-4 text-xs text-muted-foreground">Last updated {formatDate(latest.timestamp)}</p>
          )}
        </TabsContent>

        <TabsContent value="tvl" className="mt-4">
          <div className="mb-4 grid grid-cols-3 gap-3 sm:w-96">
            <StatTile
              label="TVL"
              value={formatUsd(latest?.tvl)}
              animate={latest?.tvl != null ? { value: latest.tvl, format: "usd" } : undefined}
            />
            <StatTile label="24h" customValue={<PercentChange value={latest?.tvlChange1d} />} />
            <StatTile label="7d" customValue={<PercentChange value={latest?.tvlChange7d} />} />
          </div>
          <Card className="p-4">
            <RangedAreaChart data={tvlHistory} />
          </Card>
        </TabsContent>

        <TabsContent value="fees" className="mt-4">
          <MetricTab label="Fees" metric="fees" latestValue={latest?.fees24h} history={feesHistory} />
        </TabsContent>

        <TabsContent value="revenue" className="mt-4">
          <MetricTab label="Revenue" metric="revenue" latestValue={latest?.revenue24h} history={revenueHistory} />
        </TabsContent>

        <TabsContent value="volume" className="mt-4">
          <MetricTab label="Volume" metric="volume" latestValue={latest?.volume24h} history={volumeHistory} />
        </TabsContent>

        <TabsContent value="chains" className="mt-4">
          <Card className="p-4">
            <ChainDistribution chains={chainBreakdown} />
          </Card>
        </TabsContent>

        <TabsContent value="yields" className="mt-4">
          {protocolYields.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No yield pools tracked for {protocol.name} yet.
            </p>
          ) : (
            <YieldsTable
              pools={protocolYields}
              isSignedIn={Boolean(session?.user)}
              watchedPoolIds={watchedPoolIds}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
