import { checkPublicApiRateLimit } from "@/lib/api/response";
import { getTokensList, type TokenListItem, type TokenSort } from "@/lib/database/queries/tokens";
import { toCsv, csvResponse } from "@/lib/utils/csv";

const VALID_SORTS: TokenSort[] = ["marketCap", "price", "volume24h", "priceChange24h"];

export async function GET(request: Request) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const sortParam = searchParams.get("sort");
  const sort = VALID_SORTS.includes(sortParam as TokenSort) ? (sortParam as TokenSort) : undefined;

  const rows = await getTokensList({ chainSlug: searchParams.get("chain") ?? undefined, sort });

  const csv = toCsv<TokenListItem>(rows, [
    { header: "Symbol", value: (r) => r.symbol },
    { header: "Name", value: (r) => r.name },
    { header: "Address", value: (r) => r.address },
    { header: "Chain", value: (r) => r.chainName },
    { header: "Price (USD)", value: (r) => r.priceUsd },
    { header: "24h Change (%)", value: (r) => r.priceChange24h },
    { header: "Market Cap (USD)", value: (r) => r.marketCap },
    { header: "24h Volume (USD)", value: (r) => r.volume24h },
  ]);

  return csvResponse("defihub-tokens.csv", csv);
}
