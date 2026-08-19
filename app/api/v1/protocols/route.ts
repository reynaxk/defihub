import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getProtocolsList, type ProtocolSort } from "@/lib/database/queries/protocols";

const VALID_SORTS: ProtocolSort[] = ["tvl", "change1d", "change7d", "fees", "revenue", "volume"];

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const sortParam = searchParams.get("sort");
  const result = await getProtocolsList({
    category: searchParams.get("category") ?? undefined,
    chainSlug: searchParams.get("chain") ?? undefined,
    search: searchParams.get("q") ?? undefined,
    sortBy: VALID_SORTS.includes(sortParam as ProtocolSort) ? (sortParam as ProtocolSort) : undefined,
    sortDir: searchParams.get("dir") === "asc" ? "asc" : undefined,
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
