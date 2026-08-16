import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { checkAlerts } from "@/workers/alerts/check";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await checkAlerts();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:check-alerts]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
