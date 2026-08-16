import { apiError, apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getChainBySlug } from "@/lib/database/queries/chains";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { slug } = await params;
  const result = await getChainBySlug(slug);
  if (!result) return apiError(`No chain found with slug "${slug}"`, 404);

  return apiSuccess({
    data: {
      name: result.chain.name,
      slug: result.chain.slug,
      nativeToken: result.chain.nativeToken,
      chainId: result.chain.chainId,
      explorerUrl: result.chain.explorerUrl,
      tvl: result.latestTvl,
      topProtocols: result.topProtocols.map((p) => ({ name: p.name, slug: p.slug, tvl: p.tvl })),
      history: result.history,
    },
  });
}
