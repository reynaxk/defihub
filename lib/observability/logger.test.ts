import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, setErrorHook } from "./logger";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    setErrorHook(null);
  });

  it("routes each level to the matching console method", () => {
    logger.info("ok", { component: "test" });
    logger.warn("careful", { component: "test" });
    logger.error("bad", { component: "test" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("redacts fields whose key looks sensitive, leaving ordinary fields alone", () => {
    logger.info("token issued", {
      component: "test",
      apiKey: "sk-live-12345",
      password: "hunter2",
      authorization: "Bearer abc123",
      accessToken: "at-98765",
      chain: "ethereum",
    });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("sk-live-12345");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("at-98765");
    expect(line).toContain("ethereum");
  });

  it("does not redact ordinary key/token-shaped fields common in this app's own domain", () => {
    // Regression test: the first real run against workers/onchain/verify.ts
    // (a `key` field holding a plain identifier like "lido-eth-steth", not
    // a secret) was incorrectly redacted before this fix - bare "key"/
    // "token" alone must not match, only compound secret-shaped names.
    logger.info("verified", {
      component: "onchain",
      key: "lido-eth-steth",
      token: "USDC",
      tokenId: "abc-123",
    });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("lido-eth-steth");
    expect(line).toContain("USDC");
    expect(line).toContain("abc-123");
  });

  it("serializes an Error field to name/message instead of the raw object", () => {
    logger.error("failed", { component: "test", error: new Error("boom") });

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("boom");
    expect(line).toContain("Error");
  });

  it("calls the error hook only for error-level logs, with the same redacted entry", () => {
    const hook = vi.fn();
    setErrorHook(hook);

    logger.warn("not an error", { component: "test", secret: "x" });
    expect(hook).not.toHaveBeenCalled();

    logger.error("is an error", { component: "test", secret: "x" });
    expect(hook).toHaveBeenCalledTimes(1);
    expect((hook.mock.calls[0][0] as Record<string, unknown>).secret).toBe("[redacted]");
  });

  it("does not throw if the error hook itself throws", () => {
    setErrorHook(() => {
      throw new Error("hook is broken");
    });

    expect(() => logger.error("still logs", { component: "test" })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
