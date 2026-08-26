import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { recheckVolumeReorgs } from "@/lib/onchain/volume/reorg";
import { logger } from "@/lib/observability/logger";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await recheckVolumeReorgs();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("volume reorg recheck failed", { component: "cron", operation: "recheck-volume-reorgs", error: err });
    return NextResponse.json({ ok: false, error: "Volume reorg recheck failed - see server logs" }, { status: 500 });
  }
}
