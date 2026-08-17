import Link from "next/link";
import { ArrowRight, Coins, Layers, Sprout, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/stats/stat-tile";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ChainsTable } from "@/components/chains/chains-table";
import { TopMovers } from "@/components/tokens/top-movers";
import { getProtocolCount, getTopProtocols } from "@/lib/database/queries/protocols";
import { getTopChains } from "@/lib/database/queries/chains";
import { getYieldPoolCount } from "@/lib/database/queries/yields";
import { getTopMovers } from "@/lib/database/queries/tokens";
import { formatUsd } from "@/lib/format";
import { SUPPORTED_CHAINS } from "@/lib/config/chains";

export const revalidate = 300;

export default async function HomePage() {
  const [topProtocols, topChains, protocolCount, yieldPoolCount, movers] = await Promise.all([
    getTopProtocols(10),
    getTopChains(),
    getProtocolCount(),
    getYieldPoolCount(),
    getTopMovers(5),
  ]);

  const totalTvl = topChains.reduce((sum, c) => sum + (c.tvl ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <section className="flex flex-col items-start gap-4 py-8 sm:py-12">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          DeFi data, tracked clearly.
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          ChainScope aggregates TVL, fees, revenue and yield data across {SUPPORTED_CHAINS.length}{" "}
          chains into one clean dashboard — so you can see what&apos;s actually happening on-chain.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button
            size="lg"
            render={
              <Link href="/protocols">
                Explore protocols <ArrowRight className="size-4" />
              </Link>
            }
          />
          <Button size="lg" variant="outline" render={<Link href="/yields">Find yield</Link>} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 py-6 sm:grid-cols-4">
        <StatTile label="Total value locked" value={formatUsd(totalTvl)} icon={Wallet} />
        <StatTile label="Protocols tracked" value={protocolCount.toLocaleString()} icon={Layers} />
        <StatTile label="Yield pools" value={yieldPoolCount.toLocaleString()} icon={Sprout} />
        <StatTile label="Chains supported" value={String(SUPPORTED_CHAINS.length)} icon={Coins} />
      </section>

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Top movers</h2>
          <Link href="/tokens?sort=priceChange24h" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <TopMovers gainers={movers.gainers} losers={movers.losers} />
      </section>

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Top protocols</h2>
          <Link href="/protocols" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ProtocolsTable protocols={topProtocols} />
      </section>

      <section className="py-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Chains</h2>
          <Link href="/chains" className="text-sm text-primary hover:underline">
            View all
          </Link>
        </div>
        <ChainsTable chains={topChains} />
      </section>
    </div>
  );
}
