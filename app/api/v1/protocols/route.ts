import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getProtocolsList } from "@/lib/database/queries/protocols";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const result = await getProtocolsList({
    category: searchParams.get("category") ?? undefined,
    chainSlug: searchParams.get("chain") ?? undefined,
    search: searchParams.get("q") ?? undefined,
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
