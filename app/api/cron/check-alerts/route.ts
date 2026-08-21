import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { checkAlerts } from "@/workers/alerts/check";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await checkAlerts();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("check failed", { component: "cron", operation: "check-alerts", error: err });
    return NextResponse.json({ ok: false, error: "Check failed - see server logs" }, { status: 500 });
  }
}
