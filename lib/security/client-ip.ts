/**
 * Best-effort client IP extraction. Standard `Request` objects have no
 * `.ip` field (unlike the old `NextApiRequest`); this is what Vercel and
 * most reverse proxies set. Falls back to a shared bucket in
 * environments without a proxy in front (e.g. bare local dev) - less
 * precise, but still bounds total request volume rather than doing
 * nothing.
 *
 * Kept in its own module, separate from rate-limit.ts, because that file
 * imports the DB client - which throws eagerly at import time without
 * DATABASE_URL (see lib/database/client.ts), and vitest doesn't load
 * .env.local. This pure helper needs to be importable in tests without
 * that side effect, same reasoning as lib/ai/prompt-safety.ts being split
 * out from its sibling DB-touching module.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
