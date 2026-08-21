"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RangedAreaChart } from "@/components/charts/ranged-area-chart";
import type { StablecoinListItem } from "@/lib/database/queries/stablecoins";

export interface StablecoinSupplyHistory {
  symbol: string;
  data: { timestamp: string; value: number | null }[];
}

// Reuses the exact per-token history route/chart already proven on the
// token detail page (fetchEndpoint + valueField="marketCap") - a
// stablecoin's marketCap *is* its circulating supply, so no new API or
// chart primitive is needed to show "supply history". `histories` carries
// each symbol's real server-fetched default-range data - RangedAreaChart
// only calls fetchEndpoint when the user switches *away* from the default
// range, so the initially-rendered range still needs real data passed in
// directly, the same as every other RangedAreaChart caller in this app.
export function StablecoinChartPanel({
  stablecoins,
  histories,
}: {
  stablecoins: StablecoinListItem[];
  histories: StablecoinSupplyHistory[];
}) {
  const [symbol, setSymbol] = useState(stablecoins[0]?.symbol);
  if (stablecoins.length === 0) return null;
  const historyBySymbol = new Map(histories.map((h) => [h.symbol, h.data]));

  return (
    <Tabs value={symbol} onValueChange={(v) => v && setSymbol(v)}>
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        {stablecoins.map((s) => (
          <TabsTrigger key={s.symbol} value={s.symbol}>
            {s.symbol}
          </TabsTrigger>
        ))}
      </TabsList>
      {stablecoins.map((s) => (
        <TabsContent key={s.symbol} value={s.symbol} className="mt-4">
          <RangedAreaChart
            data={historyBySymbol.get(s.symbol) ?? []}
            valueKind="usd"
            defaultRange="30d"
            fetchEndpoint={`/api/tokens/${s.representativeAddress}/history?chain=${s.representativeChainSlug}`}
            valueField="marketCap"
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
