import type { Metadata } from "next";
import { ProtocolsTable } from "@/components/protocols/protocols-table";
import { ProtocolFilters } from "@/components/protocols/protocol-filters";
import { ExportCsvButton } from "@/components/shared/export-csv-button";
import { Pagination } from "@/components/shared/pagination";
import { getAllCategories, getProtocolsList } from "@/lib/database/queries/protocols";
import { getAllChains } from "@/lib/database/queries/chains";
import { getWatchedProtocolIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Protocols",
  description: "Browse DeFi protocols ranked by total value locked, fees, revenue and volume.",
};

export const revalidate = 300;

const VALID_SORTS = ["tvl", "change1d", "change7d", "fees", "revenue", "volume"] as const;

export default async function ProtocolsPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    chain?: string;
    q?: string;
    page?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const sortBy = (VALID_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as (typeof VALID_SORTS)[number])
    : "tvl";
  const sortDir = params.dir === "asc" ? "asc" : "desc";

  const [session, result, categories, chains] = await Promise.all([
    auth(),
    getProtocolsList({
      category: params.category,
      chainSlug: params.chain,
      search: params.q,
      sortBy,
      sortDir,
      page,
    }),
    getAllCategories(),
    getAllChains(),
  ]);
  const watchedProtocolIds = await getWatchedProtocolIds(
    session?.user?.id,
    result.items.map((p) => p.id),
  );

  // Uses result.page (what getProtocolsList actually normalized/queried
  // with - floored, clamped to >= 1) rather than the raw local `page`, so
  // an out-of-range page (?page=999 past the last real page) or a
  // non-integer one (?page=2.9) doesn't produce a "Showing X-Y" range or
  // rank numbers that don't match the rows actually rendered below.
  const firstRow = (result.page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.total, result.page * result.pageSize);

  function buildHref(targetPage: number) {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.chain) query.set("chain", params.chain);
    if (params.q) query.set("q", params.q);
    if (params.sort) query.set("sort", params.sort);
    if (params.dir) query.set("dir", params.dir);
    if (targetPage > 1) query.set("page", String(targetPage));
    const qs = query.toString();
    return qs ? `/protocols?${qs}` : "/protocols";
  }

  // Same param convention as ProtocolFilters' own sort <Select> - a header
  // click and the dropdown both land on the identical URL shape. Sorting
  // also invalidates the current page, same as buildHref's own pagination
  // links do for a filter change.
  function buildSortHref(sortKey: string, dir: "asc" | "desc") {
    const query = new URLSearchParams();
    if (params.category) query.set("category", params.category);
    if (params.chain) query.set("chain", params.chain);
    if (params.q) query.set("q", params.q);
    if (sortKey !== "tvl") query.set("sort", sortKey);
    if (dir === "asc") query.set("dir", dir);
    const qs = query.toString();
    return qs ? `/protocols?${qs}` : "/protocols";
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Protocols</h1>
      <p className="mt-1 text-muted-foreground">
        {result.total === 0
          ? "No protocols match these filters"
          : `Showing ${firstRow.toLocaleString("en-US")}–${lastRow.toLocaleString("en-US")} of ${result.total.toLocaleString("en-US")} protocols`}
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ProtocolFilters categories={categories} chains={chains} />
        <ExportCsvButton endpoint="/api/export/protocols" />
      </div>

      <div className="mt-4">
        <ProtocolsTable
          protocols={result.items}
          rankOffset={(result.page - 1) * result.pageSize}
          isSignedIn={Boolean(session?.user)}
          watchedProtocolIds={watchedProtocolIds}
          sort={{ key: sortBy, dir: sortDir, hrefFor: buildSortHref }}
        />
      </div>

      <Pagination page={result.page} totalPages={result.totalPages} buildHref={buildHref} />
    </div>
  );
}
