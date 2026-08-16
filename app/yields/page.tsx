import type { Metadata } from "next";
import { YieldsTable } from "@/components/yields/yields-table";
import { YieldFilters } from "@/components/yields/yield-filters";
import { getYieldPools } from "@/lib/database/queries/yields";
import { getAllChains } from "@/lib/database/queries/chains";

export const metadata: Metadata = {
  title: "Yields",
  description: "Discover DeFi yield opportunities ranked by APY across supported chains.",
};

export const revalidate = 300;

export default async function YieldsPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; stable?: string }>;
}) {
  const params = await searchParams;
  const [pools, chains] = await Promise.all([
    getYieldPools({ chainSlug: params.chain, stablecoinOnly: params.stable === "1" }),
    getAllChains(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Yields</h1>
      <p className="mt-1 text-muted-foreground">
        {pools.length} pools with at least $10K TVL, ranked by APY
      </p>

      <div className="mt-6">
        <YieldFilters chains={chains} />
      </div>

      <div className="mt-4">
        <YieldsTable pools={pools} />
      </div>
    </div>
  );
}
