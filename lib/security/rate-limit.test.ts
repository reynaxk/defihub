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
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { getClientIp } from "./client-ip";
import { checkRateLimit } from "./rate-limit";

describe("getClientIp", () => {
  it("prefers x-vercel-forwarded-for - the header Vercel's own edge sets and does not let an extra proxy layer overwrite", () => {
    const req = new Request("http://localhost", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.5",
        "x-forwarded-for": "1.2.3.4", // would win if x-vercel-forwarded-for weren't checked first
      },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip - identical to x-forwarded-for on Vercel, and what the official @vercel/functions ipAddress() helper reads", () => {
    const req = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to x-forwarded-for for non-Vercel deployments, using the last address defensively", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("10.0.0.1");
  });

  it("x-forwarded-for fallback is not fooled by a client-supplied first entry", () => {
    // The first entry is whatever the connecting client claims via its own
    // request header - fully attacker-controlled on a direct request.
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.5" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("handles a single-entry x-forwarded-for fallback (no intermediate proxies)", () => {
    const req = new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("skips a trailing empty entry from a trailing comma and returns the last real address", () => {
    const req = new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.5, " } });
    expect(getClientIp(req)).toBe("203.0.113.5");
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
