import type { Metadata } from "next";
import { YieldsTable } from "@/components/yields/yields-table";
import { YieldFilters } from "@/components/yields/yield-filters";
import { ExportCsvButton } from "@/components/shared/export-csv-button";
import { Pagination } from "@/components/shared/pagination";
import { getYieldCategories, getYieldPoolsList } from "@/lib/database/queries/yields";
import { getAllChains } from "@/lib/database/queries/chains";
import { getWatchedPoolIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";
import { parseOptionalNumber } from "@/lib/utils/query-params";

export const metadata: Metadata = {
  title: "Yields",
  description: "Discover DeFi yield opportunities ranked by APY across supported chains.",
};

export const revalidate = 300;

interface YieldsSearchParams {
  chain?: string;
  category?: string;
  risk?: string;
  stable?: string;
  q?: string;
  minTvl?: string;
  sort?: string;
  dir?: string;
  page?: string;
}

export default async function YieldsPage({
  searchParams,
}: {
  searchParams: Promise<YieldsSearchParams>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const ilRisk = params.risk === "yes" || params.risk === "no" ? params.risk : undefined;
  const sortBy = params.sort === "tvl" ? "tvl" : "apy";
  const sortDir = params.dir === "asc" ? "asc" : "desc";

  const [session, result, categories, chains] = await Promise.all([
    auth(),
    getYieldPoolsList({
      chainSlug: params.chain,
      category: params.category,
      stablecoinOnly: params.stable === "1",
      ilRisk,
      search: params.q,
      minTvl: parseOptionalNumber(params.minTvl),
      sortBy,
      sortDir,
      page,
    }),
    getYieldCategories(),
    getAllChains(),
  ]);

  const watchedPoolIds = await getWatchedPoolIds(
    session?.user?.id,
    result.items.map((p) => p.id),
  );

  // Uses result.page (what getYieldPoolsList actually normalized/queried
  // with) rather than the raw local `page`, so an out-of-range or
  // non-integer ?page= value doesn't produce a "Showing X-Y" range that
  // doesn't match the rows actually rendered below.
  const firstRow = (result.page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.total, result.page * result.pageSize);

  function buildHref(targetPage: number) {
    const query = new URLSearchParams();
    if (params.chain) query.set("chain", params.chain);
    if (params.category) query.set("category", params.category);
    if (params.risk) query.set("risk", params.risk);
    if (params.stable) query.set("stable", params.stable);
    if (params.q) query.set("q", params.q);
    if (params.minTvl) query.set("minTvl", params.minTvl);
    if (params.sort) query.set("sort", params.sort);
    if (params.dir) query.set("dir", params.dir);
    if (targetPage > 1) query.set("page", String(targetPage));
    const qs = query.toString();
    return qs ? `/yields?${qs}` : "/yields";
  }

  function buildSortHref(sortKey: string, dir: "asc" | "desc") {
    const query = new URLSearchParams();
    if (params.chain) query.set("chain", params.chain);
    if (params.category) query.set("category", params.category);
    if (params.risk) query.set("risk", params.risk);
    if (params.stable) query.set("stable", params.stable);
    if (params.q) query.set("q", params.q);
    if (params.minTvl) query.set("minTvl", params.minTvl);
    if (sortKey !== "apy") query.set("sort", sortKey);
    if (dir === "asc") query.set("dir", dir);
    const qs = query.toString();
    return qs ? `/yields?${qs}` : "/yields";
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="border-b border-border/60 pb-6">
        <p className="text-xs font-medium tracking-[0.15em] text-muted-foreground uppercase">DeFi Markets</p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">Yields</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {result.total === 0
            ? "No pools match these filters"
            : `Showing ${firstRow.toLocaleString("en-US")}–${lastRow.toLocaleString("en-US")} of ${result.total.toLocaleString("en-US")} pools with at least $10K TVL`}
        </p>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          APY is a snapshot, not a guaranteed or historical return - it moves with pool activity and reward-token
          prices, and very high APYs shown in amber/red usually reflect emissions or thin liquidity rather than
          sustainable yield.
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <YieldFilters chains={chains} categories={categories} />
        <ExportCsvButton endpoint="/api/export/yields" />
      </div>

      <div className="mt-4">
        <YieldsTable
          pools={result.items}
          isSignedIn={Boolean(session?.user)}
          watchedPoolIds={watchedPoolIds}
          sort={{ key: sortBy, dir: sortDir, hrefFor: buildSortHref }}
        />
      </div>

      <Pagination page={result.page} totalPages={result.totalPages} buildHref={buildHref} />
    </div>
  );
}
