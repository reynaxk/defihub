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
    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    logger.error("rollup failed", { component: "cron", operation: "rollup-metrics", error: err });
    return NextResponse.json({ ok: false, error: "Rollup failed - see server logs" }, { status: 500 });
  }
}
