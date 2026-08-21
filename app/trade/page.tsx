import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import { ComingSoon } from "@/components/shared/coming-soon";

export const metadata: Metadata = {
  title: "Trade",
  description: "Non-custodial DeFi trading, wallet-controlled and fully routed.",
};

export default function TradePage() {
  return (
    <ComingSoon
      icon={ArrowLeftRight}
      eyebrow="DeFiHub Trade"
      title="Non-custodial trading is not live yet"
      description="DeFiHub does not execute trades today - wallet balances are read-only. A trading terminal is planned, but only ships once it can be transparently routed and wallet-signed, never a custodial black box."
      planned={[
        "A professional trading chart per pair, with standard interval controls",
        "Transparent routing across DEXs/aggregators, shown before you confirm",
        "Expected output, minimum received and price impact, disclosed up front",
        "Every trade signed and broadcast from your own wallet - DeFiHub never holds funds",
      ]}
    />
  );
}
