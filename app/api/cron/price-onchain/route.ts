import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { logger } from "@/lib/observability/logger";
import { priceOnchain } from "@/workers/onchain/price";

export const maxDuration = 30;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await priceOnchain();
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("pricing failed", { component: "cron", operation: "price-onchain", error: err });
    return NextResponse.json({ ok: false, error: "Pricing failed - see server logs" }, { status: 500 });
  }
}
