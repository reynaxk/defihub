import { NextResponse } from "next/server";
import { z } from "zod";
import { runResearchQuery } from "@/lib/research/engine";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

// Public (no auth) - matches every other read-only data surface in the app.
// Capped generously by IP since each request runs a handful of the same
// queries the rest of the app already makes, not an external/paid API call.
const RESEARCH_LIMIT = { limit: 30, windowMs: 60 * 1000 };

const querySchema = z.object({ query: z.string().trim().min(1).max(300) });

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limited = await checkRateLimit(`research:${ip}`, RESEARCH_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = querySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const result = await runResearchQuery(parsed.data.query);
  if (!result) {
    return NextResponse.json({ result: null, query: parsed.data.query });
  }

  return NextResponse.json({ result });
}
