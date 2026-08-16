import type { Metadata } from "next";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ProtocolFilters } from "@/components/protocols/protocol-filters";
import { getAllCategories, getProtocolsList } from "@/lib/database/queries/protocols";
import { getAllChains } from "@/lib/database/queries/chains";

export const metadata: Metadata = {
  title: "Protocols",
  description: "Browse DeFi protocols ranked by total value locked, fees, revenue and volume.",
};

export const revalidate = 300;

export default async function ProtocolsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; chain?: string; q?: string }>;
}) {
  const params = await searchParams;
  const [protocols, categories, chains] = await Promise.all([
    getProtocolsList({ category: params.category, chainSlug: params.chain, search: params.q }),
    getAllCategories(),
    getAllChains(),
  ]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Protocols</h1>
      <p className="mt-1 text-muted-foreground">{protocols.length} protocols on supported chains</p>

      <div className="mt-6">
        <ProtocolFilters categories={categories} chains={chains} />
      </div>

      <div className="mt-4">
        <ProtocolsTable protocols={protocols} />
      </div>
    </div>
  );
}
