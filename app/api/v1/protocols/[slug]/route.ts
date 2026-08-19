import { apiError, apiOptions, apiSuccess, checkPublicApiRateLimit } from "@/lib/api/response";
import { getProtocolBySlug } from "@/lib/database/queries/protocols";

export async function OPTIONS() {
  return apiOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { slug } = await params;
  const result = await getProtocolBySlug(slug);
  if (!result) return apiError(`No protocol found with slug "${slug}"`, 404);

  return apiSuccess({
    data: {
      name: result.protocol.name,
      slug: result.protocol.slug,
      description: result.protocol.description,
      website: result.protocol.website,
      logoUrl: result.protocol.logoUrl,
      category: result.protocol.category,
      chains: result.chains.map((c) => c.slug),
      current: result.latest,
      history: result.history,
    },
  });
}
