import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, getClientIp } from "./rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
    }
  });

  it("blocks the request that exceeds the limit", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) checkRateLimit(key, { limit: 3, windowMs: 60_000 });
    const result = checkRateLimit(key, { limit: 3, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) checkRateLimit(key, { limit: 3, windowMs: 60_000 });
    expect(checkRateLimit(key, { limit: 3, windowMs: 60_000 }).allowed).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(checkRateLimit(key, { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const keyA = `test-a-${Math.random()}`;
    const keyB = `test-b-${Math.random()}`;
    for (let i = 0; i < 3; i++) checkRateLimit(keyA, { limit: 3, windowMs: 60_000 });
    expect(checkRateLimit(keyA, { limit: 3, windowMs: 60_000 }).allowed).toBe(false);
    expect(checkRateLimit(keyB, { limit: 3, windowMs: 60_000 }).allowed).toBe(true);
  });
});

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
