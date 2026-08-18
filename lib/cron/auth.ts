import { timingSafeEqual } from "node:crypto";
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

  const authHeader = request.headers.get("authorization") ?? "";
  if (!secretsMatch(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

// Plain `!==` short-circuits on the first differing byte, which leaks how
// many leading characters of the secret a guess got right via response
// timing. These routes are unauthenticated-by-design (Vercel's cron caller
// carries no other credential), so the header comparison is the only thing
// standing between an off-path attacker and the sync/verification workers.
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
