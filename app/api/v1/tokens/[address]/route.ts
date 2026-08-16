import { apiError, apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getTokenByAddress } from "@/lib/database/queries/tokens";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { address } = await params;
  const { searchParams } = new URL(request.url);
  // A contract address is only unique per-chain, not globally (see
  // getTokenByAddress) - ?chain disambiguates the same way the app route does.
  const result = await getTokenByAddress(address, searchParams.get("chain") ?? undefined);
  if (!result) return apiError(`No token found with address "${address}"`, 404);

  return apiSuccess({
    data: {
      symbol: result.token.symbol,
      name: result.token.name,
      address: result.token.address,
      logoUrl: result.token.logoUrl,
      decimals: result.token.decimals,
      coingeckoId: result.token.coingeckoId,
      chain: result.chain.slug,
      current: result.latest,
      history: result.history,
    },
  });
}
