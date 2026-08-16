import { NextResponse } from "next/server";

/**
 * Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}` when it
 * invokes a scheduled route, so checking that header covers production.
 * Locally, pass the same header by hand (or just run the worker script
 * directly via `npm run sync:*` instead of hitting the route).
 */
export function assertCronAuthorized(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
