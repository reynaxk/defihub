import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getTokensList, type TokenSort } from "@/lib/database/queries/tokens";

const VALID_SORTS: TokenSort[] = ["marketCap", "price", "volume24h"];

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const sortParam = searchParams.get("sort");
  const sort = VALID_SORTS.includes(sortParam as TokenSort) ? (sortParam as TokenSort) : undefined;

  const data = await getTokensList({
    chainSlug: searchParams.get("chain") ?? undefined,
    sort,
  });

  return apiSuccess({ data });
}
