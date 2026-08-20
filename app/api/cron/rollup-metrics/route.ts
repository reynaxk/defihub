import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { rollupMetrics } from "@/workers/retention/rollup";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    const stats = await rollupMetrics();
    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    console.error("[cron:rollup-metrics]", err);
    return NextResponse.json({ ok: false, error: "Rollup failed - see server logs" }, { status: 500 });
  }
}
