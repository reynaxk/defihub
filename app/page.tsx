import Link from "next/link";
import { ArrowRight, Coins, DollarSign, Layers, Sprout, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/stats/stat-tile";
import { PercentChange } from "@/components/shared/percent-change";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ChainsTable } from "@/components/chains/chains-table";
import { TopMovers } from "@/components/tokens/top-movers";
import { getGlobal24hTotals, getProtocolCount, getTopProtocols } from "@/lib/database/queries/protocols";
import { getGlobalTvlHistory, getTopChains } from "@/lib/database/queries/chains";
import { getYieldPoolCount } from "@/lib/database/queries/yields";
import { getTopMovers } from "@/lib/database/queries/tokens";
import { getWatchedChainIds, getWatchedProtocolIds } from "@/lib/database/queries/watchlist";
import { computeTvlChanges } from "@/lib/database/queries/tvl-change";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";
import { SUPPORTED_CHAINS } from "@/lib/config/chains";

export const revalidate = 300;

export default async function HomePage() {
  const session = await auth();
  const [
    topProtocols,
    topChains,
    protocolCount,
    yieldPoolCount,
    movers24h,
    movers7d,
    globalHistory,
    global24h,
  ] = await Promise.all([
    getTopProtocols(10),
    getTopChains(),
    getProtocolCount(),
    getYieldPoolCount(),
    getTopMovers(5, "24h"),
    getTopMovers(5, "7d"),
    getGlobalTvlHistory(),
    getGlobal24hTotals(),
  ]);
  // Derived from the history already fetched above, rather than a second
  // call to a function that would re-run the same expensive date_trunc/SUM
  // aggregate query over chain_metrics from scratch.
  const globalChanges = computeTvlChanges(globalHistory);

  const [watchedProtocolIds, watchedChainIds] = await Promise.all([
    getWatchedProtocolIds(session?.user?.id, topProtocols.map((p) => p.id)),
    getWatchedChainIds(session?.user?.id, topChains.map((c) => c.id)),
  ]);

  const totalTvl = topChains.reduce((sum, c) => sum + (c.tvl ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <section className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 flex flex-col items-start gap-4 py-8 duration-700 sm:py-12">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          DeFi intelligence, all in one place.
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          DeFiHub tracks TVL, volume, fees, revenue and yields across {SUPPORTED_CHAINS.length}{" "}
          chains and thousands of protocols — one clean dashboard for what&apos;s actually happening on-chain.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button
            size="lg"
            render={
              <Link href="/protocols">
                Explore DeFi <ArrowRight className="size-4" />
              </Link>
            }
          />
          <Button size="lg" variant="outline" render={<Link href="/protocols">Explore protocols</Link>} />
        </div>
      </section>

      <section className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 grid grid-cols-2 gap-3 py-6 delay-150 duration-700 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Total value locked"
          value={formatUsd(totalTvl)}
          icon={Wallet}
          animate={{ value: totalTvl, format: "usd" }}
        />
        <StatTile label="24h TVL change" customValue={<PercentChange value={globalChanges.change24h} />} />
        <StatTile label="7d TVL change" customValue={<PercentChange value={globalChanges.change7d} />} />
        <StatTile label="30d TVL change" customValue={<PercentChange value={globalChanges.change30d} />} />
        <StatTile
          label="Chains supported"
          value={String(SUPPORTED_CHAINS.length)}
          icon={Coins}
          animate={{ value: SUPPORTED_CHAINS.length, format: "count" }}
        />
        <StatTile
          label="Protocols tracked"
          value={protocolCount.toLocaleString()}
          icon={Layers}
          animate={{ value: protocolCount, format: "count" }}
        />
        <StatTile
          label="Yield pools"
          value={yieldPoolCount.toLocaleString()}
          icon={Sprout}
          animate={{ value: yieldPoolCount, format: "count" }}
        />
        <StatTile
          label="24h volume"
          value={formatUsd(global24h.volume24h)}
          icon={DollarSign}
          animate={global24h.volume24h != null ? { value: global24h.volume24h, format: "usd" } : undefined}
        />
        <StatTile
          label="24h fees"
          value={formatUsd(global24h.fees24h)}
          animate={global24h.fees24h != null ? { value: global24h.fees24h, format: "usd" } : undefined}
        />
        <StatTile
          label="24h revenue"
          value={formatUsd(global24h.revenue24h)}
          animate={global24h.revenue24h != null ? { value: global24h.revenue24h, format: "usd" } : undefined}
        />
      </section>

      <section className="py-8">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Total DeFi TVL</h2>
        <div className="rounded-lg border border-border bg-card p-4">
          <RangedAreaChart
            data={globalHistory.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))}
            height={320}
            defaultRange="90d"
          />
        </div>
      </section>

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Top movers</h2>
          <Link href="/tokens?sort=priceChange24h" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <TopMovers movers24h={movers24h} movers7d={movers7d} />
      </section>

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Top protocols</h2>
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

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Chains</h2>
          <Link href="/chains" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ChainsTable chains={topChains} isSignedIn={Boolean(session?.user)} watchedChainIds={watchedChainIds} />
      </section>
    </div>
  );
}
