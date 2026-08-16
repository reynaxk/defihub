import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { syncTokens } from "@/workers/tokens/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncTokens();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:sync-tokens]", err);
    return NextResponse.json({ ok: false, error: "Sync failed - see server logs" }, { status: 500 });
  }
}
