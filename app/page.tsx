import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MetricHeader } from "@/components/stats/metric-header";
import { MetricRow } from "@/components/stats/metric-row";
import { ChangeBadge } from "@/components/shared/change-badge";
import { AnimatedNumber } from "@/components/stats/animated-number";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { MarketPulse } from "@/components/chains/market-pulse";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ChainsTable } from "@/components/chains/chains-table";
import { TopMovers } from "@/components/tokens/top-movers";
import {
  getGlobal24hTotals,
  getGlobalMetricsHistory,
  getProtocolCount,
  getTopProtocols,
} from "@/lib/database/queries/protocols";
import { getChainSparklines, getGlobalTvlHistory, getTopChains } from "@/lib/database/queries/chains";
import { getYieldPoolCount } from "@/lib/database/queries/yields";
import { getTopMovers } from "@/lib/database/queries/tokens";
import { getWatchedChainIds, getWatchedProtocolIds } from "@/lib/database/queries/watchlist";
import { computeTvlChanges } from "@/lib/database/queries/tvl-change";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";
import { sumKnownValues } from "@/lib/utils/aggregate";
import { SUPPORTED_CHAINS } from "@/lib/config/chains";

export const revalidate = 300;

const MARKET_PULSE_CHAINS = 7;

export default async function HomePage() {
  const [
    session,
    topProtocols,
    topChains,
    protocolCount,
    yieldPoolCount,
    movers24h,
    movers7d,
    globalTvlHistory,
    globalMetricsHistory,
    global24h,
  ] = await Promise.all([
    auth(),
    getTopProtocols(10),
    getTopChains(),
    getProtocolCount(),
    getYieldPoolCount(),
    getTopMovers(5, "24h"),
    getTopMovers(5, "7d"),
    getGlobalTvlHistory(),
    getGlobalMetricsHistory(),
    getGlobal24hTotals(),
  ]);
  // Derived from history already fetched above, rather than a second call
  // that would re-run the same expensive date_trunc/SUM aggregate query.
  const globalChanges = computeTvlChanges(globalTvlHistory);

  const pulseChains = topChains.slice(0, MARKET_PULSE_CHAINS);
  const [watchedProtocolIds, watchedChainIds, sparklines] = await Promise.all([
    getWatchedProtocolIds(session?.user?.id, topProtocols.map((p) => p.id)),
    getWatchedChainIds(session?.user?.id, topChains.map((c) => c.id)),
    getChainSparklines(pulseChains.map((c) => c.id)),
  ]);

  // A chain with no synced history has an unknown TVL, not a zero one - `??
  // 0` here would silently understate the platform's headline number.
  const { total: totalTvl, isPartial: tvlPartial } = sumKnownValues(topChains.map((c) => c.tvl));

  // globalTvlHistory (chain_metrics) and globalMetricsHistory (protocol_metrics)
  // are two separate day-bucketed queries - both truncate to UTC midnight the
  // same way, so matching on the ISO day string merges them correctly without
  // a third query.
  const metricsByDay = new Map(globalMetricsHistory.map((m) => [m.timestamp.toISOString(), m]));
  const mergedHistory = globalTvlHistory.map((h) => {
    const iso = h.timestamp.toISOString();
    const m = metricsByDay.get(iso);
    return {
      timestamp: iso,
      tvl: h.tvl as number | null,
      volume24h: m?.volume24h ?? null,
      fees24h: m?.fees24h ?? null,
      revenue24h: m?.revenue24h ?? null,
    };
  });

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <section className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-6 duration-700">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">DeFi intelligence, all in one place.</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Tracking TVL, volume, fees, revenue and yields across {SUPPORTED_CHAINS.length} chains and thousands of
            protocols — grounded in DeFiHub&apos;s own indexed on-chain data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            render={
              <Link href="/protocols">
                Explore DeFi <ArrowRight className="size-4" />
              </Link>
            }
          />
          <Button variant="outline" render={<Link href="/research">DeFiHub Research</Link>} />
        </div>
      </section>

      <section className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 py-6 delay-150 duration-700">
        <MetricHeader
          eyebrow="Global DeFi"
          value={totalTvl != null ? <AnimatedNumber value={totalTvl} format="usd" /> : "—"}
          label={`Total value locked${tvlPartial ? " (partial — some chains unavailable)" : ""}`}
          change={<ChangeBadge value={globalChanges.change24h} period="24H" />}
        />
        <MetricRow
          className="mt-6"
          items={[
            { label: "7D change", value: <ChangeBadge value={globalChanges.change7d} /> },
            { label: "30D change", value: <ChangeBadge value={globalChanges.change30d} /> },
            { label: "24H volume", value: formatUsd(global24h.volume24h) },
            { label: "24H fees", value: formatUsd(global24h.fees24h) },
            { label: "24H revenue", value: formatUsd(global24h.revenue24h) },
            { label: "Chains", value: <AnimatedNumber value={SUPPORTED_CHAINS.length} format="count" /> },
            { label: "Protocols", value: <AnimatedNumber value={protocolCount} format="count" /> },
            { label: "Yield pools", value: <AnimatedNumber value={yieldPoolCount} format="count" /> },
          ]}
        />
      </section>

      <section className="py-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="p-4 sm:p-6">
            <Tabs defaultValue="tvl">
              <TabsList variant="line">
                <TabsTrigger value="tvl">TVL</TabsTrigger>
                <TabsTrigger value="volume">Volume</TabsTrigger>
                <TabsTrigger value="fees">Fees</TabsTrigger>
                <TabsTrigger value="revenue">Revenue</TabsTrigger>
              </TabsList>
              <TabsContent value="tvl" className="mt-4">
                <RangedAreaChart
                  data={mergedHistory.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))}
                  height={360}
                  defaultRange="90d"
                />
              </TabsContent>
              <TabsContent value="volume" className="mt-4">
                <RangedAreaChart
                  data={mergedHistory.map((h) => ({ timestamp: h.timestamp, value: h.volume24h }))}
                  height={360}
                  defaultRange="90d"
                />
              </TabsContent>
              <TabsContent value="fees" className="mt-4">
                <RangedAreaChart
                  data={mergedHistory.map((h) => ({ timestamp: h.timestamp, value: h.fees24h }))}
                  height={360}
                  defaultRange="90d"
                />
              </TabsContent>
              <TabsContent value="revenue" className="mt-4">
                <RangedAreaChart
                  data={mergedHistory.map((h) => ({ timestamp: h.timestamp, value: h.revenue24h }))}
                  height={360}
                  defaultRange="90d"
                />
              </TabsContent>
            </Tabs>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-medium text-foreground">Market Pulse</h2>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">TVL and 24h change by chain</p>
            {pulseChains.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No chains synced yet.</p>
            ) : (
              <MarketPulse
                chains={pulseChains.map((c) => ({
                  id: c.id,
                  slug: c.slug,
                  name: c.name,
                  logoUrl: c.logoUrl,
                  tvl: c.tvl,
                  change24h: c.change24h,
                  sparkline: sparklines.get(c.id) ?? [],
                }))}
              />
            )}
          </Card>
        </div>
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-widest text-muted-foreground uppercase">Top movers</h2>
          <Link href="/tokens?sort=priceChange24h" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <TopMovers movers24h={movers24h} movers7d={movers7d} />
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-widest text-muted-foreground uppercase">Top protocols</h2>
          <Link href="/protocols" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ProtocolsTable
          protocols={topProtocols}
          isSignedIn={Boolean(session?.user)}
          watchedProtocolIds={watchedProtocolIds}
        />
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-widest text-muted-foreground uppercase">Chains</h2>
          <Link href="/chains" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ChainsTable chains={topChains} isSignedIn={Boolean(session?.user)} watchedChainIds={watchedChainIds} />
      </section>
    </div>
  );
}
