import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Card } from "@/components/ui/card";
import { MetricHeader } from "@/components/stats/metric-header";
import { StatTile } from "@/components/stats/stat-tile";
import { TvlAreaChart } from "@/components/charts/tvl-area-chart";
import { NativeDailyChart } from "@/components/pools/native-daily-chart";
import { NativeSourceBadge } from "@/components/pools/native-source-badge";
import { NativeTokenPrices } from "@/components/pools/native-token-prices";
import {
  getNativePoolFeesHistory,
  getNativePoolIdentity,
  getNativePoolOverview,
  getNativePoolTokenPrices,
  getNativePoolTvlHistory,
  getNativePoolVolumeHistory,
  type NativeMetric,
} from "@/lib/database/queries/native-pools";
import { formatNumber, formatUsd } from "@/lib/format";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ chainSlug: string; address: string }> }): Promise<Metadata> {
  const { chainSlug, address } = await params;
  const identity = await getNativePoolIdentity(chainSlug, address);
  if (!identity) return {};
  return {
    title: `${identity.label} — Native On-Chain Data`,
    description: `TVL, volume, and fees for ${identity.label} on ${identity.chainName}, computed directly from DeFiHub's own on-chain reads where available.`,
  };
}

// Part 2's own explicit requirement: an UNAVAILABLE metric is displayed as
// exactly that - "No native data yet" - never a $0/blank tile that could
// be mistaken for a real zero. A metric WITH a real value still shows its
// own NativeSourceBadge next to it, so native/hybrid/external is never
// ambiguous at a glance.
function MetricTile({ label, metric, formatValue }: { label: string; metric: NativeMetric<number>; formatValue: (value: number) => string }) {
  if (metric.value == null) {
    return (
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums tracking-tight text-muted-foreground/50">No native data yet</p>
      </Card>
    );
  }
  return (
    <StatTile
      label={label}
      customValue={
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{formatValue(metric.value)}</span>
          <NativeSourceBadge source={metric.source} />
        </div>
      }
    />
  );
}

// Defined outside the component - see dashboard/page.tsx's own identical
// comment on why the react-compiler purity rule wants Date.now() out of a
// component body even though this Server Component already runs fresh per
// request.
function ninetyDaysAgo(): Date {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
}

export default async function PoolDetailPage({ params }: { params: Promise<{ chainSlug: string; address: string }> }) {
  const { chainSlug, address } = await params;
  const overview = await getNativePoolOverview(chainSlug, address);
  if (!overview) notFound();

  const { identity, tvl, volume, fees, swapCount, observationCount, earliestObservedAt } = overview;

  const [tvlHistory, volumeHistory, feesHistory, tokenPrices] = await Promise.all([
    getNativePoolTvlHistory(identity.poolId, ninetyDaysAgo()),
    getNativePoolVolumeHistory(identity.poolId),
    getNativePoolFeesHistory(identity.poolId),
    getNativePoolTokenPrices(identity.poolId, chainSlug),
  ]);

  const explorerLink = identity.explorerUrl ? `${identity.explorerUrl}/address/${identity.address}` : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-[0.15em] text-muted-foreground uppercase">
            {identity.chainName}
            {identity.protocolName ? ` · ${identity.protocolName}` : ""}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{identity.label}</h1>
          {explorerLink ? (
            <a href={explorerLink} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
              {identity.address}
            </a>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{identity.address}</span>
          )}
        </div>
      </div>

      <MetricHeader
        eyebrow="Total value locked"
        value={
          <span className="flex items-baseline gap-3">
            {tvl.value != null ? formatUsd(tvl.value, { compact: false }) : <span className="text-muted-foreground/50">No native data yet</span>}
            <NativeSourceBadge source={tvl.source} className="text-sm" />
          </span>
        }
        label={tvl.observedAt ? `as of block ${tvl.blockNumber?.toLocaleString("en-US")} · ${formatDistanceToNow(tvl.observedAt, { addSuffix: true })}` : "never independently verified on-chain"}
        className="mt-6"
      />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile label="Native volume (latest observation)" metric={volume} formatValue={(v) => formatUsd(v, { compact: false })} />
        <MetricTile label="Native fees (latest observation)" metric={fees} formatValue={(v) => formatUsd(v, { compact: false })} />
        <StatTile label="Swaps indexed" value={formatNumber(swapCount)} />
        <StatTile label="TVL observations" value={observationCount > 0 ? `${formatNumber(observationCount)} since ${earliestObservedAt ? formatDistanceToNow(earliestObservedAt, { addSuffix: true }) : "—"}` : "0"} />
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-1">
        <NativeTokenPrices tokens={tokenPrices} />
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">TVL history (90 days)</h2>
          <TvlAreaChart data={tvlHistory.map((p) => ({ timestamp: p.timestamp, value: p.value }))} />
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Native volume, by day</h2>
          <NativeDailyChart data={volumeHistory.map((p) => ({ day: p.day, value: p.value, isPartial: p.isPartial }))} />
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Native fees, by day</h2>
          <NativeDailyChart data={feesHistory.map((p) => ({ day: p.day, value: p.value, isPartial: p.isPartial }))} />
        </Card>
      </div>

      <p className="mt-6 max-w-2xl text-xs text-muted-foreground">
        TVL, volume, and fees on this page are computed by DeFiHub&apos;s own on-chain indexing and pricing engines, independent of DefiLlama/CoinGecko wherever the{" "}
        <NativeSourceBadge source="NATIVE" className="align-middle" /> label appears — see each metric&apos;s own badge for exactly which parts of the calculation were native vs. external.
      </p>
    </div>
  );
}
