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
  // x-vercel-forwarded-for / x-real-ip are only edge-set, unspoofable
  // headers when this process is actually running on Vercel's platform -
  // process.env.VERCEL is Vercel's own documented "always set in this
  // environment" flag (vercel.com/docs/environment-variables). Outside
  // Vercel (bare local dev, another host) these are just ordinary
  // client-suppliable headers with no enforcement behind them, so trusting
  // them unconditionally would let any caller spoof its own IP.
  if (process.env.VERCEL) {
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
  }

  // Outside Vercel, only trust x-forwarded-for through an explicitly
  // configured number of trusted proxy hops in front of this process. A
  // well-behaved proxy chain only ever APPENDS to the x-forwarded-for
  // value it received (never rewrites earlier entries), so the entry the
  // innermost *trusted* proxy actually observed is always exactly
  // trustedProxyCount positions in from the right - regardless of how many
  // fake entries an attacker prepends further left in the chain.
  // TRUSTED_PROXY_COUNT unset/0 means "no trusted proxy is known to be in
  // front of this process", i.e. don't trust client-suppliable headers at
  // all - not "trust the first entry", which would be spoofable.
  //
  // There is deliberately no further fallback to "the server connection
  // address" here: Next.js App Router Route Handlers receive a standard
  // Web `Request`, which has no raw socket/connection-address field
  // (unlike Node's `http.IncomingMessage.socket.remoteAddress`) - that
  // information simply isn't available at this layer of the framework.
  const trustedProxyCount = Number(process.env.TRUSTED_PROXY_COUNT ?? "0");
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor && trustedProxyCount > 0) {
    const parts = forwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const clientIndex = parts.length - trustedProxyCount;
    if (clientIndex >= 0 && parts[clientIndex]) return parts[clientIndex];
  }

  return "unknown";
}
