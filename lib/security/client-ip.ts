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
  // Vercel's own documentation (vercel.com/docs/headers/request-headers):
  // "If you are trying to use Vercel behind a proxy, we currently overwrite
  // the X-Forwarded-For header and do not forward external IPs" - Vercel's
  // edge sets this directly from the connection it received, it is not a
  // client-appendable multi-hop chain the way a generic reverse proxy's
  // would be (a prior version of this function assumed that generic
  // semantics and parsed it as one - wrong model for this platform, even
  // though it happened to produce a plausible-looking value). Preferred
  // first because the same docs note x-forwarded-for "could be overwritten
  // if you're using a proxy on top of Vercel" (e.g. an additional CDN/WAF
  // layer this app doesn't control) - x-vercel-forwarded-for stays the
  // value Vercel's own edge actually saw regardless.
  const vercelForwardedFor = request.headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor) return vercelForwardedFor;

  // Documented as identical to x-forwarded-for on Vercel, and what
  // Vercel's own official `@vercel/functions` ipAddress() helper reads
  // (verified against its source - a single Headers.get(), no chain
  // parsing) - not worth adding that package as a dependency just to call
  // the one line it wraps.
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  // Fallback for non-Vercel deployments (e.g. bare local dev behind a
  // different reverse proxy) - not a platform-guaranteed-authentic header
  // here, so treated defensively: if multi-valued, the last entry is
  // closer to what actually connected to this process than a
  // client-suppliable first entry would be.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Scan from the end for the first non-empty entry, rather than only
    // checking the last split segment - a trailing separator (e.g.
    // "203.0.113.5, ", which some proxies do produce) makes the literal
    // last segment an empty string after trimming, which would otherwise
    // discard a perfectly valid address one position earlier.
    const parts = forwardedFor.split(",").map((p) => p.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]) return parts[i];
    }
  }

  return "unknown";
}
