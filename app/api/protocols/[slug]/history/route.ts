import { NextResponse } from "next/server";
import { getProtocolHistory, getProtocolIdBySlug } from "@/lib/database/queries/protocols";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { isChartRangeKey, sinceForRange } from "@/lib/charts/ranges";

// Internal, app-only endpoint (not part of the documented /api/v1/* public
// API) - powers RangedAreaChart's range switcher on the protocol detail
// page's TVL/Fees/Revenue/Volume tabs. One response carries every metric so
// switching tabs never needs a second request. Generous limit since a user
// clicking through several tabs x ranges in quick succession is normal use.
const HISTORY_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(`protocol-history:${ip}`, HISTORY_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { slug } = await params;
  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range");
  if (!isChartRangeKey(range)) {
    return NextResponse.json({ error: "Invalid or missing range" }, { status: 400 });
  }

  const protocolId = await getProtocolIdBySlug(slug);
  if (!protocolId) return NextResponse.json({ error: "Protocol not found" }, { status: 404 });

  const since = sinceForRange(range);
  const history = await getProtocolHistory(protocolId, since);
  return NextResponse.json({ history, since: since ? since.toISOString() : null });
}
