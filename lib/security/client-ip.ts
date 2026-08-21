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
  if (forwardedFor) {
    // Each proxy hop APPENDS the address it received the request from, so
    // the chain reads client -> proxy1 -> proxy2 -> ... -> last hop before
    // this server. The FIRST entry is whatever the original client claimed
    // - fully attacker-controllable on a direct request (Vercel's edge
    // does not strip or overwrite it) - which previously let every IP-scoped
    // rate limit in this app (login, registration, forgot-password, the
    // public API, search, history routes) be bypassed by sending a fresh
    // random value on every request. The LAST entry is appended by Vercel's
    // own edge from the connection it actually received, which a client
    // cannot forge.
    const parts = forwardedFor.split(",").map((p) => p.trim());
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
