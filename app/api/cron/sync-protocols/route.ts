import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { syncProtocols } from "@/workers/protocols/sync";

export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    await syncProtocols();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[cron:sync-protocols]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
