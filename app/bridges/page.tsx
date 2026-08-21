import type { Metadata } from "next";
import { Waypoints } from "lucide-react";
import { ComingSoon } from "@/components/shared/coming-soon";

export const metadata: Metadata = {
  title: "Bridges",
  description: "Cross-chain bridge volume, TVL and net flows.",
};

export default function BridgesPage() {
  return (
    <ComingSoon
      icon={Waypoints}
      eyebrow="Bridge Intelligence"
      title="Bridge data isn't indexed yet"
      description="DeFiHub doesn't ingest bridge volume or route data today - this page will only show real figures once that pipeline exists, not estimated or placeholder numbers."
      planned={[
        "Bridge volume and TVL by route",
        "Net flows and 7-day change",
        "Top routes, ranked by volume",
        "A readable flow visualization between chains",
      ]}
    />
  );
}
