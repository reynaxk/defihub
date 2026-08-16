import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { syncYields } from "@/workers/yields/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncYields();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:sync-yields]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
