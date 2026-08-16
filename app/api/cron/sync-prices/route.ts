import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { syncPrices } from "@/workers/prices/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncPrices();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:sync-prices]", err);
    return NextResponse.json({ ok: false, error: "Sync failed - see server logs" }, { status: 500 });
  }
}
