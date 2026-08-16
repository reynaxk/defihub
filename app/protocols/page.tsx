import type { Metadata } from "next";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ProtocolFilters } from "@/components/protocols/protocol-filters";
import { Pagination } from "@/components/shared/pagination";
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
  searchParams: Promise<{ category?: string; chain?: string; q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const [result, categories, chains] = await Promise.all([
    getProtocolsList({ category: params.category, chainSlug: params.chain, search: params.q, page }),
    getAllCategories(),
    getAllChains(),
  ]);

  const firstRow = (page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.total, page * result.pageSize);

  function buildHref(targetPage: number) {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.chain) query.set("chain", params.chain);
    if (params.q) query.set("q", params.q);
    if (targetPage > 1) query.set("page", String(targetPage));
    const qs = query.toString();
    return qs ? `/protocols?${qs}` : "/protocols";
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Protocols</h1>
      <p className="mt-1 text-muted-foreground">
        {result.total === 0
          ? "No protocols match these filters"
          : `Showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${result.total.toLocaleString()} protocols`}
      </p>

      <div className="mt-6">
        <ProtocolFilters categories={categories} chains={chains} />
      </div>

      <div className="mt-4">
        <ProtocolsTable protocols={result.items} rankOffset={(page - 1) * result.pageSize} />
      </div>

      <Pagination page={page} totalPages={result.totalPages} buildHref={buildHref} />
    </div>
  );
}
