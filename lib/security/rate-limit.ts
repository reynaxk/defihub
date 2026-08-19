import { sql } from "drizzle-orm";
import { db } from "@/lib/database/client";

// Re-exported so every existing call site
// (`import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit"`)
// keeps working unchanged - the implementation moved to its own module so
// it stays importable in tests without pulling in the DB client. See
// client-ip.ts for why.
export { getClientIp } from "./client-ip";

// Postgres-backed, not in-memory. This app deploys as Vercel serverless
// functions (vercel.json's `crons` array only has meaning there), which
// routes concurrent requests across multiple isolated instances and cold-
// starts routinely - an in-memory Map's state isn't shared across any of
// that, so it couldn't actually enforce a limit under real traffic (every
// instance sees its own request as the first one, and every cold start
// resets everyone's count to zero for free). The database is the one piece
// of shared state every instance already has a connection to, so it's the
// natural place for this without introducing new infrastructure (Redis/
// Upstash) just for rate limiting. See lib/database/schema.ts's
// rateLimitBuckets table for the storage-side reasoning.
//
// The increment-and-check happens in a single INSERT ... ON CONFLICT
// statement, not a separate read-then-write - Postgres executes the
// UPDATE side of an ON CONFLICT atomically per row (it takes a row-level
// lock for the duration of the statement), so two concurrent requests for
// the same key are serialized by the database itself rather than racing in
// application code. Whichever one commits second sees the first one's
// incremented count.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Deliberately probabilistic rather than a separate cron job or a JS-level
// setInterval: this runs inside the same serverless function invocations
// that are already calling checkRateLimit, so there's no persistent
// process to hang a timer off, and adding a dedicated cron entry just for
// housekeeping felt like more moving parts than this needs. At normal
// traffic volumes across this app's dozen-plus rate-limited routes, 1%
// still fires often enough to keep the table from growing unbounded.
// Awaited (not fire-and-forget) specifically because a serverless
// invocation can be frozen/torn down the instant its response is sent -
// an un-awaited promise here could simply never run to completion.
const CLEANUP_PROBABILITY = 0.01;
const BUCKET_RETENTION = sql`interval '1 day'`;

async function maybeCleanupOldBuckets(): Promise<void> {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  try {
    await db.execute(sql`delete from rate_limit_buckets where window_start < now() - ${BUCKET_RETENTION}`);
  } catch (err) {
    // Best-effort housekeeping - a failed cleanup shouldn't take down rate
    // limiting itself, which is the thing actually protecting the route.
    console.error("[rate-limit] cleanup failed:", err);
  }
}

interface BucketRow extends Record<string, unknown> {
  count: number;
  window_start: string;
}

export async function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  void maybeCleanupOldBuckets();

  const windowInterval = sql`make_interval(secs => ${windowMs / 1000})`;

  // `now()` is evaluated once per statement in Postgres (not once per
  // reference), so the two uses below - in the fresh-row default and in
  // the conflict branch's staleness check - are guaranteed consistent
  // within this one round trip.
  const rows = await db.execute<BucketRow>(sql`
    insert into rate_limit_buckets (key, count, window_start)
    values (${key}, 1, now())
    on conflict (key) do update set
      count = case
        when rate_limit_buckets.window_start <= now() - ${windowInterval}
          then 1
          else rate_limit_buckets.count + 1
      end,
      window_start = case
        when rate_limit_buckets.window_start <= now() - ${windowInterval}
          then now()
          else rate_limit_buckets.window_start
      end
    returning count, window_start
  `);

  const row = rows[0];
  const count = Number(row.count);
  const windowStartMs = new Date(row.window_start).getTime();

  if (count > limit) {
    const retryAfterSeconds = Math.max(0, Math.ceil((windowStartMs + windowMs - Date.now()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}
