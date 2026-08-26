import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { indexOnchainVolume } from "@/workers/onchain/volume";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await indexOnchainVolume();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("volume indexing failed", { component: "cron", operation: "index-volume", error: err });
    return NextResponse.json({ ok: false, error: "Volume indexing failed - see server logs" }, { status: 500 });
  }
}
