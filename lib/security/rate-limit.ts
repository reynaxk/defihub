// In-memory sliding-window rate limiter. Deliberately not Redis-backed:
// this app runs as a single instance today, and Redis was explicitly
// deferred until the product actually needs shared cache/queue state -
// inventing that infra just for rate limiting would be scope creep.
// Caveat this carries: limits reset on redeploy and don't share state
// across instances, so this needs to move to a shared store (Redis, etc.)
// before running more than one instance in production.

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Periodic sweep so the map doesn't grow unbounded across long-running
// processes. Five minutes is frequent enough to matter, infrequent enough
// to not cost anything.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

function sweep(maxWindowMs: number) {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= maxWindowMs) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): RateLimitResult {
  sweep(windowMs);

  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((bucket.windowStart + windowMs - now) / 1000),
    };
  }

  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP extraction. Standard `Request` objects have no
 * `.ip` field (unlike the old `NextApiRequest`); this is what Vercel and
 * most reverse proxies set. Falls back to a shared bucket in
 * environments without a proxy in front (e.g. bare local dev) - less
 * precise, but still bounds total request volume rather than doing
 * nothing.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
