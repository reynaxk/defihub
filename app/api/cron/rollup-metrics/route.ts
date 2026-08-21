import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { rollupMetrics } from "@/workers/retention/rollup";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    const stats = await rollupMetrics();
    // stats is null specifically when another invocation already held the
    // advisory lock (see rollup.ts) - an explicit `skipped` flag makes
    // that unambiguous to a caller/monitor reading the response, rather
    // than relying on inferring "skipped" from the absence of a stats
    // payload.
    return NextResponse.json({ ok: true, skipped: stats === null, stats });
  } catch (err) {
    logger.error("rollup failed", { component: "cron", operation: "rollup-metrics", error: err });
    return NextResponse.json({ ok: false, error: "Rollup failed - see server logs" }, { status: 500 });
  }
}
