import type { Metadata } from "next";
import { Waypoints } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MetricHeader } from "@/components/stats/metric-header";
import { MetricRow } from "@/components/stats/metric-row";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { FlowVisualization } from "@/components/shared/flow-visualization";
import { getProtocolChainBadges, getProtocolsList } from "@/lib/database/queries/protocols";
import { getWatchedProtocolIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { formatUsd } from "@/lib/format";

export const metadata: Metadata = {
  title: "Bridges",
  description: "Cross-chain bridge protocol TVL, tracked live on DeFiHub.",
};

export const revalidate = 300;

// DeFiLlama's own protocol taxonomy - not a DeFiHub invention. Combined
// because "which of these four is really a bridge" isn't a distinction this
// page needs to make; a caller who does can still filter by the single
// `category` on /protocols.
const BRIDGE_CATEGORIES = ["Bridge", "Canonical Bridge", "Cross Chain Bridge", "Bridge Aggregator"];
const BRIDGE_TABLE_LIMIT = 25;

export default async function BridgesPage() {
  const session = await auth();
  const result = await getProtocolsList({
    categories: BRIDGE_CATEGORIES,
    sortBy: "tvl",
    pageSize: BRIDGE_TABLE_LIMIT,
  });

  const [watchedProtocolIds, chainsByProtocolId] = await Promise.all([
    getWatchedProtocolIds(session?.user?.id, result.items.map((p) => p.id)),
    getProtocolChainBadges(result.items.map((p) => p.id)),
  ]);

  const totalTvl = result.items.reduce((sum, p) => (p.tvl != null ? sum + p.tvl : sum), 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-primary uppercase">
        <Waypoints className="size-3.5" />
        Bridge Intelligence
      </div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Bridge protocols, by TVL</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        DeFiHub tracks the value locked in bridge contracts across {result.total} protocols DefiLlama classifies as
        bridges - a real, indexed figure. It does not yet ingest bridge transaction volume, per-route flow, or net
        transfer data; those sections below say so explicitly rather than showing an estimate.
      </p>

      <div className="mt-6">
        <MetricHeader value={formatUsd(totalTvl)} label={`TVL across top ${result.items.length} bridge protocols`} />
        <MetricRow className="mt-6" items={[{ label: "Bridge protocols tracked", value: String(result.total) }]} />
      </div>

      <Card className="mt-8 p-4">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Bridge protocols</h2>
        <ProtocolsTable
          protocols={result.items}
          isSignedIn={Boolean(session?.user)}
          watchedProtocolIds={watchedProtocolIds}
          chainsByProtocolId={chainsByProtocolId}
        />
      </Card>

      <Card className="mt-6 p-4">
        <h2 className="mb-1 text-sm font-medium text-muted-foreground">Volume, net flows &amp; top routes</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          DeFiHub doesn&apos;t ingest per-route bridge volume or transfer data today - this section will show real
          figures once that pipeline exists, not estimated or placeholder numbers.
        </p>
        <FlowVisualization
          flows={[]}
          emptyMessage="Bridge route and flow data isn't tracked yet"
          emptyDetail="TVL locked in a bridge's contracts (shown above) is real and indexed today, but it doesn't tell you which chains funds are actually moving between - that needs transaction-level route data DeFiHub doesn't ingest yet."
        />
      </Card>
    </div>
  );
}
