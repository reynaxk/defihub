import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/cron/auth";
import { getLatestSyncStatus } from "@/lib/observability/sync-health";

// Internal/operator-only - same bearer-token gate as every other cron
// route (not itself scheduled; queried on demand to answer "is ingestion
// actually working" without reading raw platform logs). Deliberately not
// public: per-worker error summaries could reveal internal details not
// meant for external consumers of the public /api/v1/* API.
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const workers = await getLatestSyncStatus();
  return NextResponse.json({ workers });
}
