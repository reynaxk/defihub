import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { discoverOnchainPools } from "@/workers/onchain/discover-pools";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await discoverOnchainPools();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("pool discovery failed", { component: "cron", operation: "discover-pools", error: err });
    return NextResponse.json({ ok: false, error: "Pool discovery failed - see server logs" }, { status: 500 });
  }
}
