import { DistributionBarList } from "@/components/shared/distribution-bar-list";
import type { ProtocolChainBreakdownItem } from "@/lib/database/queries/protocols";

export function ChainDistribution({ chains }: { chains: ProtocolChainBreakdownItem[] }) {
  return (
    <DistributionBarList
      // A chain with unknown TVL is dropped from the breakdown rather than
      // coerced to 0 - folding it in as 0 would be silently correct today
      // but would then distort the total (and every other chain's share
      // of it) the moment that chain's real TVL becomes known, and there's
      // no "unknown" bar for DistributionBarList to render anyway.
      items={chains
        .filter((chain): chain is ProtocolChainBreakdownItem & { tvl: number } => chain.tvl != null)
        .map((chain) => ({
          key: chain.chainSlug,
          label: chain.chainName,
          value: chain.tvl,
          href: `/chain/${chain.chainSlug}`,
          logoUrl: chain.chainLogoUrl,
        }))}
      emptyMessage="No per-chain breakdown available yet."
    />
  );
}
