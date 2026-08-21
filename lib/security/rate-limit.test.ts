// checkRateLimit's tests below hit a real Postgres database rather than
// mocking it: its actual correctness lives entirely in a single SQL
// statement's atomicity (the INSERT ... ON CONFLICT in rate-limit.ts's
// checkRateLimit), which a mock can't meaningfully exercise - the whole
// point of that statement shape is that Postgres itself serializes
// concurrent requests for the same key, not application code, so the only
// way to actually verify it is to fire real concurrent requests at a real
// database and check what comes back.
//
// This requires DATABASE_URL to resolve to a real, reachable Postgres
// instance - the same requirement every other DB-touching script in this
// project already has (db:migrate, seed, the sync:* workers). The "test"
// npm script loads .env.local via dotenv-cli for exactly this reason (see
// package.json) - previously it didn't, which is why these tests didn't
// exist here before: importing anything that touches the DB client threw
// immediately without DATABASE_URL, and vitest doesn't load .env.local on
// its own.
//
// Every test below uses a key prefixed with a random per-run id so repeated
// local runs can't collide with leftover rows from a previous run, and all
// rows are deleted in the top-level afterAll.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { getClientIp } from "./client-ip";
import { checkRateLimit } from "./rate-limit";

describe("getClientIp", () => {
  beforeEach(() => {
    // Tests below rely on VERCEL/TRUSTED_PROXY_COUNT being unset to
    // exercise the off-Vercel/no-trusted-proxy paths - without pinning a
    // known baseline here, that would silently depend on the ambient
    // environment the test happens to run in (e.g. a real Vercel CI
    // runner where VERCEL is genuinely set, or a .env.local defining
    // TRUSTED_PROXY_COUNT for local dev), not on what each test actually
    // declares. Individual tests override these with their own
    // vi.stubEnv() call where they need a non-default value.
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers x-vercel-forwarded-for on Vercel - the header Vercel's own edge sets and does not let an extra proxy layer overwrite", () => {
    vi.stubEnv("VERCEL", "1");
    const req = new Request("http://localhost", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.5",
        "x-forwarded-for": "1.2.3.4", // would win if x-vercel-forwarded-for weren't checked first
      },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip on Vercel - identical to x-forwarded-for on Vercel, and what the official @vercel/functions ipAddress() helper reads", () => {
    vi.stubEnv("VERCEL", "1");
    const req = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("spoofed headers: ignores x-vercel-forwarded-for and x-real-ip when not actually running on Vercel", () => {
    // VERCEL intentionally left unset - off Vercel, these headers carry no
    // platform guarantee and are exactly as spoofable as any other header
    // on a direct request.
    const req = new Request("http://localhost", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.5",
        "x-real-ip": "203.0.113.9",
      },
    });
    expect(getClientIp(req)).toBe("unknown");
  });

  it("spoofed headers: ignores x-forwarded-for entirely when no trusted proxy count is configured", () => {
    // VERCEL and TRUSTED_PROXY_COUNT both unset - with no trusted proxy
    // known to be in front of this process, a caller can set
    // x-forwarded-for directly to claim to be any address.
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(getClientIp(req)).toBe("unknown");
  });

  it("one proxy: resolves the client, ignoring whatever the client itself claimed", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const req = new Request("http://localhost", {
      // "1.2.3.4" is the client's own unverified claim; "203.0.113.5" is
      // what the trusted proxy actually observed connecting to it.
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.5" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("multiple proxies: resolves the actual client rather than an intermediate proxy", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const req = new Request("http://localhost", {
      // "1.2.3.4" client-claimed, "203.0.113.5" the real client (appended
      // by the first trusted proxy), "10.0.0.2" the first trusted proxy's
      // own address (appended by the second trusted proxy) - must not be
      // mistaken for the client.
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.5, 10.0.0.2" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("spoofed headers: front-padding the chain with extra fake entries does not shift which entry is trusted", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    // Only one real proxy hop occurred, so only the rightmost entry was
    // actually appended by it - everything to its left, no matter how many
    // entries, is an attacker's own unverified claim.
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8, 1.2.3.4, 203.0.113.5" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("handles a single-entry x-forwarded-for through one trusted proxy (client sent no prior claim)", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const req = new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("skips a trailing empty entry from a trailing comma and still resolves through the trusted proxy", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const req = new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.5, " } });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("refuses to guess when the chain is shorter than the configured trusted proxy count", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.5" },
    });
    expect(getClientIp(req)).toBe("unknown");
  });

  it("falls back to unknown with no proxy headers", () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});

describe("checkRateLimit", () => {
  const runId = randomUUID();
  const keyPrefix = `test-rate-limit-${runId}-`;
  const testKey = (suffix: string) => `${keyPrefix}${suffix}`;

  afterAll(async () => {
    await db.execute(sql`delete from rate_limit_buckets where key like ${`${keyPrefix}%`}`);
    await closeDb();
  });

  it("allows exactly `limit` requests within a window and blocks the next one", async () => {
    const key = testKey("boundary");
    const opts = { limit: 3, windowMs: 60_000 };

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await checkRateLimit(key, opts));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it("reports retryAfterSeconds as 0 while allowed and positive once blocked", async () => {
    const key = testKey("retry-after");
    const opts = { limit: 1, windowMs: 60_000 };

    const first = await checkRateLimit(key, opts);
    const second = await checkRateLimit(key, opts);

    expect(first.allowed).toBe(true);
    expect(first.retryAfterSeconds).toBe(0);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets the window once it elapses, allowing requests again", async () => {
    const key = testKey("window-reset");
    const opts = { limit: 1, windowMs: 300 };

    const first = await checkRateLimit(key, opts);
    const second = await checkRateLimit(key, opts);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const third = await checkRateLimit(key, opts);
    expect(third.allowed).toBe(true);
  });

  it("tracks independent keys separately, with no cross-key interference", async () => {
    const keyA = testKey("independent-a");
    const keyB = testKey("independent-b");
    const opts = { limit: 1, windowMs: 60_000 };

    const a1 = await checkRateLimit(keyA, opts);
    const b1 = await checkRateLimit(keyB, opts);
    const a2 = await checkRateLimit(keyA, opts);
    const b2 = await checkRateLimit(keyB, opts);

    expect(a1.allowed).toBe(true);
    expect(b1.allowed).toBe(true);
    expect(a2.allowed).toBe(false);
    expect(b2.allowed).toBe(false);
  });

  it("serializes truly concurrent requests for the same key atomically - exactly `limit` succeed", async () => {
    const key = testKey("concurrent");
    const opts = { limit: 5, windowMs: 60_000 };

    // Promise.all, not a for-loop: these fire as genuinely simultaneous
    // requests, not sequenced ones - the in-memory limiter this replaced
    // would have raced and let more than `limit` through here.
    const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(key, opts)));

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(5);
  }, 15_000);
});
