import { NextResponse } from "next/server";
import { getChainHistory, getChainIdBySlug } from "@/lib/database/queries/chains";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { isChartRangeKey, sinceForRange } from "@/lib/charts/ranges";

// Internal, app-only endpoint (not part of the documented /api/v1/* public
// API) - powers RangedAreaChart's range switcher on the chain detail page's
// TVL chart. 180/min (raised from 60 during the Phase 4 historical-TVL
// audit): confirmed live that 60/min is realistic to exhaust through
// ordinary active browsing - switching ranges across a handful of chain
// pages in one session - not just abuse, and a fetch failure here (rate
// limit or otherwise) is exactly the trigger for the "chart shows the
// wrong range's data" bug fixed in computeChartDisplayState. Still a real,
// meaningful cap, just one with headroom for legitimate exploration.
const HISTORY_LIMIT = { limit: 180, windowMs: 60 * 1000 };

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(`chain-history:${ip}`, HISTORY_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { slug } = await params;
  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range");
  if (!isChartRangeKey(range)) {
    return NextResponse.json({ error: "Invalid or missing range" }, { status: 400 });
  }

  const chainId = await getChainIdBySlug(slug);
  if (!chainId) return NextResponse.json({ error: "Chain not found" }, { status: 404 });

  const since = sinceForRange(range);
  const history = await getChainHistory(chainId, since);
  return NextResponse.json({ history, since: since ? since.toISOString() : null });
}
