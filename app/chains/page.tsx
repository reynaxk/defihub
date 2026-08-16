import type { Metadata } from "next";
import { ChainsTable } from "@/components/chains/chains-table";
import { getTopChains } from "@/lib/database/queries/chains";

export const metadata: Metadata = {
  title: "Chains",
  description: "Compare total value locked across supported blockchains.",
};

export const revalidate = 300;

export default async function ChainsPage() {
  const chains = await getTopChains();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Chains</h1>
      <p className="mt-1 text-muted-foreground">{chains.length} chains tracked</p>
      <div className="mt-6">
        <ChainsTable chains={chains} />
      </div>
    </div>
  );
}
