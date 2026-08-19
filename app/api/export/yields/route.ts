import { checkPublicApiRateLimit } from "@/lib/api/response";
import { getYieldPools } from "@/lib/database/queries/yields";
import { toCsv, csvResponse } from "@/lib/utils/csv";
import { parseOptionalNumber } from "@/lib/utils/query-params";

type YieldPool = Awaited<ReturnType<typeof getYieldPools>>[number];

export async function GET(request: Request) {
  const limited = await checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const risk = searchParams.get("risk");
  const rows = await getYieldPools({
    chainSlug: searchParams.get("chain") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    stablecoinOnly: searchParams.get("stable") === "1",
    ilRisk: risk === "yes" || risk === "no" ? risk : undefined,
    search: searchParams.get("q") ?? undefined,
    minApy: parseOptionalNumber(searchParams.get("minApy")),
    minTvl: parseOptionalNumber(searchParams.get("minTvl")),
  });

  const csv = toCsv<YieldPool>(rows, [
    { header: "Pool", value: (r) => r.symbol },
    { header: "Protocol", value: (r) => r.protocolName },
    { header: "Chain", value: (r) => r.chainName },
    { header: "APY (%)", value: (r) => r.apy },
    { header: "Base APY (%)", value: (r) => r.apyBase },
    { header: "Reward APY (%)", value: (r) => r.apyReward },
    { header: "TVL (USD)", value: (r) => r.tvlUsd },
    { header: "Stablecoin", value: (r) => r.stablecoin },
    { header: "IL Risk", value: (r) => r.ilRisk },
  ]);

  return csvResponse("defihub-yields.csv", csv);
}
