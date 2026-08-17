import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { verifyOnchain } from "@/workers/onchain/verify";

export const maxDuration = 30;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await verifyOnchain();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:verify-onchain]", err);
    return NextResponse.json({ ok: false, error: "Verification failed - see server logs" }, { status: 500 });
  }
}
