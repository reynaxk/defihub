import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { getProtocolBySlug } from "@/lib/database/queries/protocols";
import {
  generateProtocolSummary,
  isAiSummaryAvailable,
} from "@/lib/ai/protocol-summary";
import { checkRateLimit } from "@/lib/security/rate-limit";

// Each call spends real Claude API credit, so this is gated behind sign-in
// (unlike the public read-only /api/v1/* endpoints) and rate-limited per
// user on top of that.
const SUMMARIZE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAiSummaryAvailable()) {
    return NextResponse.json({ error: "AI summary unavailable" }, { status: 503 });
  }

  const limited = checkRateLimit(`ai-summary:${session.user.id}`, SUMMARIZE_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const { slug } = await params;
  const data = await getProtocolBySlug(slug);
  if (!data) {
    return NextResponse.json({ error: `No protocol found with slug "${slug}"` }, { status: 404 });
  }

  try {
    const summary = await generateProtocolSummary({
      protocolId: data.protocol.id,
      name: data.protocol.name,
      category: data.protocol.category,
      description: data.protocol.description,
      tvl: data.latest?.tvl ?? null,
      fees24h: data.latest?.fees24h ?? null,
      revenue24h: data.latest?.revenue24h ?? null,
      chains: data.chains.map((c) => c.name),
    });
    return NextResponse.json({ summary });
  } catch (err) {
    console.error(`[ai-summary] generation failed for protocol ${slug}:`, err);
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 502 });
  }
}
