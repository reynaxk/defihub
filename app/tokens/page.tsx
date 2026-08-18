import type { Metadata } from "next";
import { TokensTable } from "@/components/tokens/tokens-table";
import { TokenFilters } from "@/components/tokens/token-filters";
import { ExportCsvButton } from "@/components/shared/export-csv-button";
import { Pagination } from "@/components/shared/pagination";
import { getTokensPageList, type TokenSort } from "@/lib/database/queries/tokens";
import { getAllChains } from "@/lib/database/queries/chains";
import { getWatchedTokenIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Tokens",
  description: "Top tokens by market cap across supported chains, with live prices.",
};

export const revalidate = 300;

const VALID_SORTS: TokenSort[] = ["marketCap", "price", "volume24h", "priceChange24h"];

const SORT_DESCRIPTIONS: Record<TokenSort, string> = {
  marketCap: "market cap",
  price: "price",
  volume24h: "24h volume",
  priceChange24h: "24h change",
};

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; sort?: string; page?: string }>;
}) {
  const params = await searchParams;
  const sort = VALID_SORTS.includes(params.sort as TokenSort) ? (params.sort as TokenSort) : "marketCap";
  const page = Math.max(1, Number(params.page) || 1);

  const [session, result, chains] = await Promise.all([
    auth(),
    getTokensPageList({ chainSlug: params.chain, sort, page }),
    getAllChains(),
  ]);
  const watchedTokenIds = await getWatchedTokenIds(
    session?.user?.id,
    result.items.map((t) => t.id),
  );

  const firstRow = (page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.total, page * result.pageSize);

  function buildHref(targetPage: number) {
    const query = new URLSearchParams();
    if (params.chain) query.set("chain", params.chain);
    if (params.sort) query.set("sort", params.sort);
    if (targetPage > 1) query.set("page", String(targetPage));
    const qs = query.toString();
    return qs ? `/tokens?${qs}` : "/tokens";
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
      <p className="mt-1 text-muted-foreground">
        {result.total === 0
          ? "No tokens match these filters"
          : `Showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${result.total.toLocaleString()} tokens, ranked by ${SORT_DESCRIPTIONS[sort]}`}
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TokenFilters chains={chains} />
        <ExportCsvButton endpoint="/api/export/tokens" />
      </div>

      <div className="mt-4">
        <TokensTable
          tokens={result.items}
          isSignedIn={Boolean(session?.user)}
          watchedTokenIds={watchedTokenIds}
        />
      </div>

      <Pagination page={page} totalPages={result.totalPages} buildHref={buildHref} />
    </div>
  );
}
