import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EntityLogo } from "@/components/shared/entity-logo";
import { WatchlistButton } from "@/components/shared/watchlist-button";
import { StatTile } from "@/components/stats/stat-tile";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import { AiSummaryCard } from "@/components/protocols/ai-summary-card";
import { OnchainVerificationCard } from "@/components/protocols/onchain-verification-card";
import { PercentChange } from "@/components/shared/percent-change";
import { getProtocolBySlug } from "@/lib/database/queries/protocols";
import { isWatchingProtocol } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";
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
    title: data.protocol.name,
    description:
      data.protocol.description ??
      `${data.protocol.name} TVL, fees, revenue and volume, tracked live on DeFiHub.`,
  };
}

export default async function ProtocolDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, session] = await Promise.all([getProtocolBySlug(slug), auth()]);
  if (!data) notFound();

  const { protocol, chains, history, latest } = data;
  const [watching, cachedSummary, verifications] = await Promise.all([
    isWatchingProtocol(session?.user?.id, protocol.id),
    getCachedProtocolSummary(protocol.id),
    getVerificationsForProtocol(protocol.id),
  ]);

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

      <div className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Total value locked</h2>
        <RangedAreaChart data={history.map((h) => ({ timestamp: h.timestamp, value: h.tvl }))} />
      </div>

      <OnchainVerificationCard verifications={verifications} />

      <AiSummaryCard
        slug={protocol.slug}
        isSignedIn={Boolean(session?.user)}
        aiAvailable={isAiSummaryAvailable()}
        initialSummary={
          cachedSummary
            ? { ...cachedSummary, createdAt: cachedSummary.createdAt.toISOString() }
            : null
        }
      />
    </div>
  );
}
