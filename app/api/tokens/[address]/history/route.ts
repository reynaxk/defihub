import { NextResponse } from "next/server";
import { getTokenHistory, getTokenIdByAddress } from "@/lib/database/queries/tokens";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { isChartRangeKey, sinceForRange } from "@/lib/charts/ranges";

// Internal, app-only endpoint (not part of the documented /api/v1/* public
// API) - powers RangedAreaChart's range switcher on the token detail
// page's price/market-cap charts, and the stablecoins page's per-asset
// supply-history tabs. 180/min (raised from 60 during the Phase 4
// historical-TVL audit): confirmed live that 60/min is realistic to
// exhaust through ordinary active browsing, and a fetch failure here is
// exactly the trigger for the "chart shows the wrong range's data" bug
// fixed in computeChartDisplayState.
const HISTORY_LIMIT = { limit: 180, windowMs: 60 * 1000 };

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(`token-history:${ip}`, HISTORY_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { address } = await params;
  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range");
  if (!isChartRangeKey(range)) {
    return NextResponse.json({ error: "Invalid or missing range" }, { status: 400 });
  }

  // Same chain-disambiguation as the page itself (?chain=) - a token
  // address can exist on more than one chain.
  const tokenId = await getTokenIdByAddress(address, searchParams.get("chain") ?? undefined);
  if (!tokenId) return NextResponse.json({ error: "Token not found" }, { status: 404 });

  const since = sinceForRange(range);
  const history = await getTokenHistory(tokenId, since);
  return NextResponse.json({ history, since: since ? since.toISOString() : null });
}
