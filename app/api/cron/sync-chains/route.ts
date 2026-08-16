import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { syncChains } from "@/workers/chains/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncChains();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:sync-chains]", err);
    return NextResponse.json({ ok: false, error: "Sync failed - see server logs" }, { status: 500 });
  }
}
