// checkRateLimit itself has no unit tests here anymore: it's now a thin
// wrapper around a single Postgres round trip (see rate-limit.ts's own
// comment for why - the in-memory version this replaced provided no real
// protection under this app's actual serverless deployment), and importing
// it at all pulls in the DB client, which throws eagerly without
// DATABASE_URL - vitest doesn't load .env.local, so a real database
// connection isn't available here. Its correctness (atomic increment,
// window reset, retryAfterSeconds) was verified directly against the real
// database instead, including a genuinely concurrent test mirroring the
// approach already used for the watchlist/register race-condition fixes
// earlier this session - see the commit this file changed in for details.
// getClientIp has no such dependency (moved to client-ip.ts specifically so
// it stays testable), so it keeps its own coverage below.

import { describe, expect, it } from "vitest";
import { getClientIp } from "./client-ip";

describe("getClientIp", () => {
  it("prefers x-forwarded-for, using the first address", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(getClientIp(req)).toBe("203.0.113.9");
  });

  it("falls back to unknown with no proxy headers", () => {
    const req = new Request("http://localhost");
    expect(getClientIp(req)).toBe("unknown");
  });
});
