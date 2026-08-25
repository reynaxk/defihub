import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { recheckPoolTvlReorgs } from "@/workers/onchain/recheck-reorgs";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    const stats = await recheckPoolTvlReorgs();
    // stats is null specifically when another invocation already held the
    // advisory lock (see recheck-reorgs.ts) - matches rollup-metrics'
    // route's own explicit `skipped` flag for the same situation.
    return NextResponse.json({ ok: true, skipped: stats === null, stats });
  } catch (err) {
    logger.error("reorg recheck failed", { component: "cron", operation: "recheck-reorgs", error: err });
    return NextResponse.json({ ok: false, error: "Reorg recheck failed - see server logs" }, { status: 500 });
  }
}
