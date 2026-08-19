import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getTokensPageList, type TokenSort } from "@/lib/database/queries/tokens";

const VALID_SORTS: TokenSort[] = ["marketCap", "price", "volume24h", "priceChange24h"];

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const sortParam = searchParams.get("sort");
  const sort = VALID_SORTS.includes(sortParam as TokenSort) ? (sortParam as TokenSort) : undefined;

  const result = await getTokensPageList({
    chainSlug: searchParams.get("chain") ?? undefined,
    sort,
    page: searchParams.get("page") ? Number(searchParams.get("page")) : undefined,
    pageSize: searchParams.get("pageSize") ? Number(searchParams.get("pageSize")) : undefined,
  });

  return apiSuccess({
    data: result.items,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
}
