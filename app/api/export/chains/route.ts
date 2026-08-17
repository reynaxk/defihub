import { checkPublicApiRateLimit } from "@/lib/api/response";
import { getTopChains } from "@/lib/database/queries/chains";
import { toCsv, csvResponse } from "@/lib/utils/csv";
import type { ChainListItem } from "@/lib/database/queries/chains";

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const rows = await getTopChains();

  const csv = toCsv<ChainListItem>(rows, [
    { header: "Name", value: (r) => r.name },
    { header: "Slug", value: (r) => r.slug },
    { header: "Native Token", value: (r) => r.nativeToken },
    { header: "TVL (USD)", value: (r) => r.tvl },
  ]);

  return csvResponse("defihub-chains.csv", csv);
}
