import { checkPublicApiRateLimit } from "@/lib/api/response";
import { getYieldPools } from "@/lib/database/queries/yields";
import { toCsv, csvResponse } from "@/lib/utils/csv";

type YieldPool = Awaited<ReturnType<typeof getYieldPools>>[number];

export async function GET(request: Request) {
  const limited = checkPublicApiRateLimit(request);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const rows = await getYieldPools({
    chainSlug: searchParams.get("chain") ?? undefined,
    stablecoinOnly: searchParams.get("stable") === "1",
    minApy: searchParams.get("minApy") ? Number(searchParams.get("minApy")) : undefined,
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

  return csvResponse("chainscope-yields.csv", csv);
}
