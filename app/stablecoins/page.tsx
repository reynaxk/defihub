import type { Metadata } from "next";
import Link from "next/link";
import { Coins } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MetricHeader } from "@/components/stats/metric-header";
import { MetricRow } from "@/components/stats/metric-row";
import { AnimatedNumber } from "@/components/stats/animated-number";
import { PercentChange } from "@/components/shared/percent-change";
import { EntityLogo } from "@/components/shared/entity-logo";
import { EntityBadges } from "@/components/shared/entity-badges";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { DistributionBarList } from "@/components/shared/distribution-bar-list";
import { FlowVisualization } from "@/components/shared/flow-visualization";
import { StablecoinChartPanel, type StablecoinMarketCapHistory } from "@/components/stablecoins/stablecoin-chart-panel";
import { getStablecoins, type StablecoinListItem } from "@/lib/database/queries/stablecoins";
import { getTokenHistory } from "@/lib/database/queries/tokens";
import { formatTokenPrice, formatUsd } from "@/lib/format";
import { sumKnownValues } from "@/lib/utils/aggregate";

export const metadata: Metadata = {
  title: "Stablecoins",
  description: "Stablecoin market cap, market share and cross-chain presence across tracked assets.",
};

export const revalidate = 300;

const HISTORY_DAYS = 30;
// Chart tabs stay readable and each history fetch stays cheap - the top 5
// by market cap covers every asset actually worth comparing.
const CHART_TAB_LIMIT = 5;

// Deliberately not inlined into the component below: a direct `Date.now()`
// call in a component/page body trips the React Compiler's purity check.
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export default async function StablecoinsPage() {
  const stablecoins = await getStablecoins();

  const { total: totalMarketCap, isPartial } = sumKnownValues(stablecoins.map((s) => s.marketCap));

  const since = daysAgo(HISTORY_DAYS);
  const chartCoins = stablecoins.slice(0, CHART_TAB_LIMIT);
  const histories: StablecoinMarketCapHistory[] = await Promise.all(
    chartCoins.map(async (s) => {
      const history = await getTokenHistory(s.representativeTokenId, since);
      return {
        symbol: s.symbol,
        data: history.map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.marketCap })),
      };
    }),
  );

  const columns: DataTableColumn<StablecoinListItem>[] = [
    {
      key: "asset",
      header: "Asset",
      render: (s) => (
        <span className="flex items-center gap-2 font-medium">
          <EntityLogo src={s.logoUrl} name={s.symbol} size={24} />
          {s.symbol}
          {s.name && <span className="font-normal text-muted-foreground">{s.name}</span>}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (s) => formatTokenPrice(s.priceUsd),
    },
    {
      key: "change24h",
      header: "24h",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (s) => <PercentChange value={s.priceChange24h} />,
    },
    {
      key: "marketCap",
      header: "Market cap",
      headClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (s) => formatUsd(s.marketCap),
    },
    {
      key: "share",
      header: "Share",
      headClassName: "hidden text-right sm:table-cell",
      cellClassName: "hidden text-right tabular-nums text-muted-foreground sm:table-cell",
      render: (s) =>
        s.marketCap != null && totalMarketCap != null && totalMarketCap > 0
          ? `${((s.marketCap / totalMarketCap) * 100).toFixed(1)}%`
          : "—",
    },
    {
      key: "chains",
      header: "Chains tracked",
      headClassName: "hidden md:table-cell",
      cellClassName: "hidden md:table-cell",
      render: (s) => (
        <EntityBadges
          items={s.chains.map((c) => ({ key: c.chainSlug, name: c.chainName, logoUrl: c.chainLogoUrl }))}
          groupLabel="Chains"
        />
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="border-b border-border/60 pb-6">
        <p className="flex items-center gap-1.5 text-xs font-medium tracking-[0.15em] text-primary uppercase">
          <Coins className="size-3.5" />
          Stablecoin Intelligence
        </p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">Stablecoins</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Tracked through DeFiHub&apos;s existing token pipeline, not a dedicated stablecoin sync - figures below are
          market cap (price × circulating supply), not circulating supply itself. The two only agree while an asset
          holds its $1 peg exactly; DeFiHub doesn&apos;t ingest circulating-supply data separately from price, so a
          depegged asset&apos;s market cap will diverge from its real supply here.
        </p>
      </div>

      <div className="mt-6">
        <MetricHeader
          eyebrow="Global stablecoin market cap"
          value={totalMarketCap != null ? <AnimatedNumber value={totalMarketCap} format="usd" /> : "—"}
          label={`Across ${stablecoins.length} tracked assets${isPartial ? " (partial — some assets missing a market cap)" : ""}`}
        />
        <MetricRow
          className="mt-6"
          items={[
            {
              label: "Largest asset",
              value: stablecoins[0] ? `${stablecoins[0].symbol} · ${formatUsd(stablecoins[0].marketCap)}` : "—",
            },
            { label: "Assets tracked", value: <AnimatedNumber value={stablecoins.length} format="count" /> },
          ]}
        />
      </div>

      <section className="py-6">
        <h2 className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">Market cap history</h2>
        <Card className="p-4 sm:p-6">
          <StablecoinChartPanel stablecoins={chartCoins} histories={histories} />
        </Card>
      </section>

      <section className="py-6">
        <h2 className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">Assets</h2>
        <DataTable
          columns={columns}
          rows={stablecoins}
          rowKey={(s) => s.symbol}
          emptyMessage="No stablecoins tracked yet."
        />
      </section>

      <section className="py-6">
        <h2 className="mb-4 text-xs font-medium tracking-widest text-muted-foreground uppercase">Market share</h2>
        <Card className="p-4">
          <DistributionBarList
            items={stablecoins
              .filter((s): s is StablecoinListItem & { marketCap: number } => s.marketCap != null)
              .map((s) => ({ key: s.symbol, label: s.symbol, value: s.marketCap, logoUrl: s.logoUrl }))}
            emptyMessage="No market-cap data available yet."
          />
        </Card>
      </section>

      <section className="py-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Cross-chain capital flows
          </h2>
        </div>
        <FlowVisualization
          flows={[]}
          emptyMessage="Stablecoin flow data isn't tracked yet"
          emptyDetail="DeFiHub doesn't ingest cross-chain bridge or transfer data - this section will only show real movement once that pipeline exists, not an estimate."
        />
      </section>

      <div className="mt-8 flex flex-wrap gap-3 border-t border-border/60 pt-6">
        <Link href="/tokens" className="text-sm text-primary hover:underline">
          Browse all tokens →
        </Link>
      </div>
    </div>
  );
}
