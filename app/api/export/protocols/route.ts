import { checkPublicApiRateLimit } from "@/lib/api/response";
import { getProtocolsForExport } from "@/lib/database/queries/protocols";
import { toCsv, csvResponse } from "@/lib/utils/csv";
import type { ProtocolListItem } from "@/lib/database/queries/protocols";

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const rows = await getProtocolsForExport({
    category: searchParams.get("category") ?? undefined,
    chainSlug: searchParams.get("chain") ?? undefined,
    search: searchParams.get("q") ?? undefined,
  });

  const csv = toCsv<ProtocolListItem>(rows, [
    { header: "Name", value: (r) => r.name },
    { header: "Slug", value: (r) => r.slug },
    { header: "Category", value: (r) => r.category },
    { header: "TVL (USD)", value: (r) => r.tvl },
    { header: "24h Volume (USD)", value: (r) => r.volume24h },
    { header: "24h Fees (USD)", value: (r) => r.fees24h },
    { header: "24h Revenue (USD)", value: (r) => r.revenue24h },
  ]);

  return csvResponse("defihub-protocols.csv", csv);
}
