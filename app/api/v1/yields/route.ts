import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getYieldPoolsList } from "@/lib/database/queries/yields";
import { parseOptionalNumber } from "@/lib/utils/query-params";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const risk = searchParams.get("risk");

  const result = await getYieldPoolsList({
    chainSlug: searchParams.get("chain") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    stablecoinOnly: searchParams.get("stable") === "1",
    ilRisk: risk === "yes" || risk === "no" ? risk : undefined,
    search: searchParams.get("q") ?? undefined,
    minApy: parseOptionalNumber(searchParams.get("minApy")),
    minTvl: parseOptionalNumber(searchParams.get("minTvl")),
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
