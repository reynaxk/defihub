import { describe, expect, it } from "vitest";
import { buildCsp, MATCHER_SOURCE, PROTECTED_PREFIXES } from "./csp";

// proxy.ts's middleware matcher.source is a real regex source string (this
// particular pattern uses only a capturing group + negative lookahead, both
// valid vanilla RegExp syntax) - building a real RegExp from the exact same
// exported constant the live config uses (rather than a hand-copied
// duplicate) verifies actual matching behavior without needing Next's own
// matcher compiler or importing proxy.ts itself (which pulls in the full
// NextAuth config and isn't importable directly from a plain vitest test).
function matches(pathname: string): boolean {
  return new RegExp(`^${MATCHER_SOURCE}$`).test(pathname);
}

describe("proxy matcher coverage", () => {
  it("matches API routes - the fix this covers, previously excluded entirely", () => {
    expect(matches("/api/wallet/balances")).toBe(true);
    expect(matches("/api/v1/protocols")).toBe(true);
    expect(matches("/api/cron/sync-chains")).toBe(true);
    expect(matches("/api/auth/session")).toBe(true);
  });

  it("still matches ordinary page routes", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/dashboard")).toBe(true);
    expect(matches("/protocol/lido")).toBe(true);
  });

  it("still excludes Next.js internal asset paths and favicon.ico", () => {
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });
});

describe("PROTECTED_PREFIXES", () => {
  it("never matches an /api/* path, so widening the matcher adds no new redirect-to-login behavior to API routes", () => {
    const apiPaths = ["/api/wallet/balances", "/api/dashboard-data", "/api/alerts", "/api/settings"];
    for (const path of apiPaths) {
      expect(PROTECTED_PREFIXES.some((p) => path.startsWith(p))).toBe(false);
    }
  });

  it("still matches the real protected page paths", () => {
    for (const path of ["/dashboard", "/alerts", "/settings", "/wallet"]) {
      expect(PROTECTED_PREFIXES.some((p) => path.startsWith(p))).toBe(true);
    }
  });
});

describe("buildCsp", () => {
  it("embeds the given nonce into script-src", () => {
    const csp = buildCsp("test-nonce-123");
    expect(csp).toContain("'nonce-test-nonce-123'");
  });

  it("includes the core defense-in-depth directives", () => {
    const csp = buildCsp("n");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
  });
});
