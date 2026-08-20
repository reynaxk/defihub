import { NextResponse } from "next/server";
import { getTokenHistory, getTokenIdByAddress } from "@/lib/database/queries/tokens";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { isChartRangeKey, sinceForRange } from "@/lib/charts/ranges";

// Internal, app-only endpoint (not part of the documented /api/v1/* public
// API) - powers RangedAreaChart's range switcher on the token detail
// page's price/market-cap charts.
const HISTORY_LIMIT = { limit: 60, windowMs: 60 * 1000 };

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

  const history = await getTokenHistory(tokenId, sinceForRange(range));
  return NextResponse.json({ history });
}
