import { NextResponse } from "next/server";
import { search } from "@/lib/database/queries/search";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

// Internal, app-only endpoint (not part of the documented /api/v1/* public
// API) - powers the navbar search box, generous limit since it's meant to
// fire on every keystroke.
const SEARCH_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export async function GET(request: Request) {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(`search:${ip}`, SEARCH_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const results = await search(searchParams.get("q") ?? "");
  return NextResponse.json({ results });
}
