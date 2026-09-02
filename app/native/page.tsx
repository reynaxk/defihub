import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { MetricHeader } from "@/components/stats/metric-header";
import { StatTile } from "@/components/stats/stat-tile";
import { NativeSourceBadge } from "@/components/pools/native-source-badge";
import { getNativeCoverageSummary } from "@/lib/database/queries/native-pools";
import { formatNumber, formatUsd } from "@/lib/format";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Native Coverage",
  description: "The subset of DeFiHub's pool data computed entirely by its own on-chain indexing and pricing engines, independent of DefiLlama and CoinGecko.",
};

export default async function NativeCoveragePage() {
  const summary = await getNativeCoverageSummary();
  const pools = [...summary.pools].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || (b.latestVolumeUsd ?? -1) - (a.latestVolumeUsd ?? -1));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <p className="text-xs font-medium tracking-[0.15em] text-muted-foreground uppercase">Independence, measured</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Native coverage</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Every figure below is computed directly by DeFiHub&apos;s own on-chain reads — not DefiLlama or CoinGecko. This is a genuine subset of the pools DeFiHub tracks, not its whole DeFi coverage; see{" "}
        <Link href="/protocols" className="underline hover:text-foreground">
          protocol rankings
        </Link>{" "}
        for the full, DefiLlama-sourced picture.
      </p>

      <MetricHeader eyebrow="Native-covered TVL" value={formatUsd(summary.totalNativeTvlUsd, { compact: false })} label={`across ${formatNumber(summary.nativeCoveredPoolCount)} native-covered pools`} className="mt-6" />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Native-covered volume (latest)" value={formatUsd(summary.totalNativeVolumeUsd24hEquivalent, { compact: false })} />
        <StatTile label="Native-covered fees (latest)" value={formatUsd(summary.totalNativeFeesUsd24hEquivalent, { compact: false })} />
        <StatTile label="Native-covered pools" value={formatNumber(summary.nativeCoveredPoolCount)} />
        <StatTile label="Indexed pools (native volume)" value={formatNumber(summary.indexedPoolCount)} />
      </div>

      <Card className="mt-8 p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Pool</th>
                <th className="px-4 py-3 font-medium">Chain</th>
                <th className="px-4 py-3 text-right font-medium">TVL</th>
                <th className="px-4 py-3 text-right font-medium">Volume</th>
                <th className="px-4 py-3 text-right font-medium">Fees</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.poolId} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/pool/${p.chainSlug}/${p.address}`} className="font-medium hover:underline">
                      {p.label}
                    </Link>
                    {p.protocolName && <span className="ml-1.5 text-xs text-muted-foreground">{p.protocolName}</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{p.chainName}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.tvlUsd != null ? (
                      <span className="inline-flex items-center gap-1.5">
                        {formatUsd(p.tvlUsd)}
                        <NativeSourceBadge source={p.tvlSource} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">unavailable</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.latestVolumeUsd != null ? formatUsd(p.latestVolumeUsd) : <span className="text-muted-foreground/50">unavailable</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.latestFeesUsd != null ? formatUsd(p.latestFeesUsd) : <span className="text-muted-foreground/50">unavailable</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {pools.every((p) => p.tvlUsd == null && p.latestVolumeUsd == null) && <p className="mt-4 text-sm text-muted-foreground">No native data yet — check back after the next verification run.</p>}
    </div>
  );
}
