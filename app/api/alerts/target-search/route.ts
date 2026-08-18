import { NextResponse } from "next/server";
import {
  searchChainTargets,
  searchPoolTargets,
  searchProtocolTargets,
  searchTokenTargets,
} from "@/lib/database/queries/alert-targets";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

// Internal, app-only endpoint (not part of /api/v1/*) powering the alert
// creation form's target picker - same generous per-keystroke rate limit as
// the main /api/search.
const SEARCH_LIMIT = { limit: 60, windowMs: 60 * 1000 };

const SEARCH_BY_TYPE = {
  protocol_tvl: searchProtocolTargets,
  chain_tvl: searchChainTargets,
  token_price: searchTokenTargets,
  pool_apy: searchPoolTargets,
} as const;

export async function GET(request: Request) {
  const ip = getClientIp(request);
  const limited = checkRateLimit(`alert-target-search:${ip}`, SEARCH_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const q = searchParams.get("q") ?? "";

  const searchFn = SEARCH_BY_TYPE[type as keyof typeof SEARCH_BY_TYPE];
  if (!searchFn) {
    return NextResponse.json({ error: "Invalid or missing type" }, { status: 400 });
  }

  const results = await searchFn(q);
  return NextResponse.json({ results });
}
