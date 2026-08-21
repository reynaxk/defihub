import type { Metadata } from "next";
import { Coins } from "lucide-react";
import { ComingSoon } from "@/components/shared/coming-soon";

export const metadata: Metadata = {
  title: "Stablecoins",
  description: "Stablecoin supply, market share and cross-chain flows.",
};

export default function StablecoinsPage() {
  return (
    <ComingSoon
      icon={Coins}
      eyebrow="Stablecoin Intelligence"
      title="Stablecoin tracking isn't indexed yet"
      description="DeFiHub tracks protocol, chain and yield data today, but doesn't ingest stablecoin supply or peg data yet - this page will only show real figures once that pipeline exists."
      planned={[
        "Total stablecoin supply and market share by issuer (USDT, USDC, DAI, USDS, USDe...)",
        "Supply growth over time",
        "Chain-by-chain distribution",
        "Capital flows between chains",
      ]}
    />
  );
}
