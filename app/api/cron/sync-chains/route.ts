import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { syncChains } from "@/workers/chains/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncChains();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("sync failed", { component: "cron", operation: "sync-chains", error: err });
    return NextResponse.json({ ok: false, error: "Sync failed - see server logs" }, { status: 500 });
  }
}
