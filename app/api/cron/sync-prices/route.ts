import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { syncPrices } from "@/workers/prices/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncPrices();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("sync failed", { component: "cron", operation: "sync-prices", error: err });
    return NextResponse.json({ ok: false, error: "Sync failed - see server logs" }, { status: 500 });
  }
}
