import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getYieldPools } from "@/lib/database/queries/yields";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const pools = await getYieldPools({
    chainSlug: searchParams.get("chain") ?? undefined,
    stablecoinOnly: searchParams.get("stable") === "1",
    minApy: searchParams.get("minApy") ? Number(searchParams.get("minApy")) : undefined,
  });

  return apiSuccess({ data: pools });
}
