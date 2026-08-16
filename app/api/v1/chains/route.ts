import { apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getTopChains } from "@/lib/database/queries/chains";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const chains = await getTopChains();
  return apiSuccess({ data: chains });
}
