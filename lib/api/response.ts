import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

// Generous relative to the authenticated-endpoint limits in
// lib/security/rate-limit.ts - this is meant to be genuinely usable by
// external callers, not just a token gesture. Revisit once API
// subscriptions (metered, per-key limits) actually ship.
const PUBLIC_API_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export async function checkPublicApiRateLimit(request: Request): Promise<NextResponse | null> {
  const ip = getClientIp(request);
  const result = await checkRateLimit(`public-api:${ip}`, PUBLIC_API_LIMIT);
  if (!result.allowed) {
    return apiError("Rate limit exceeded (60 requests/minute). Try again shortly.", 429, {
      "Retry-After": String(result.retryAfterSeconds),
    });
  }
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Data refreshes on the ingestion schedule (hourly for protocols/chains/
// yields), so short caching meaningfully cuts DB load from repeat callers
// without serving stale-feeling data.
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
};

export function apiSuccess<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { ...CORS_HEADERS, ...CACHE_HEADERS } });
}

export function apiError(message: string, status: number, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

export function apiOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
