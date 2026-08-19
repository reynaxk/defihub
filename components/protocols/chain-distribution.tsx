import { DistributionBarList } from "@/components/shared/distribution-bar-list";
import type { ProtocolChainBreakdownItem } from "@/lib/database/queries/protocols";

export function ChainDistribution({ chains }: { chains: ProtocolChainBreakdownItem[] }) {
  return (
    <DistributionBarList
      items={chains.map((chain) => ({
        key: chain.chainSlug,
        label: chain.chainName,
        value: chain.tvl ?? 0,
        href: `/chain/${chain.chainSlug}`,
        logoUrl: chain.chainLogoUrl,
      }))}
      emptyMessage="No per-chain breakdown available yet."
    />
  );
}
