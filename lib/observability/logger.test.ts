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

  it("serializes an Error stored under a field other than 'error'", () => {
    logger.error("failed", { component: "test", lastError: new Error("wrapped boom") });

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("wrapped boom");
  });

  it("includes an Error's cause when serializing it", () => {
    logger.error("failed", { component: "test", error: new Error("outer", { cause: new Error("inner") }) });

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).toContain("outer");
    expect(line).toContain("inner");
  });

  it("redacts a sensitive field nested one level down", () => {
    logger.info("config loaded", { component: "test", config: { apiKey: "sk-live-1", chain: "ethereum" } });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("sk-live-1");
    expect(line).toContain("ethereum");
  });

  it("redacts a sensitive field inside objects nested in an array", () => {
    logger.info("batch complete", {
      component: "test",
      attempts: [
        { provider: "primary", apiKey: "sk-live-1" },
        { provider: "secondary", apiKey: "sk-live-2" },
      ],
    });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("sk-live-1");
    expect(line).not.toContain("sk-live-2");
    expect(line).toContain("primary");
    expect(line).toContain("secondary");
  });

  it("does not throw on a self-referencing array", () => {
    const circular: unknown[] = [];
    circular.push(circular);

    expect(() => logger.info("circular array", { component: "test", items: circular })).not.toThrow();
  });

  it("redacts credentials embedded in a URL-shaped value regardless of field name", () => {
    logger.warn("provider failed", {
      component: "test",
      rpcUrl: "https://eth-mainnet.example.com/v2/super-secret-api-key-12345",
    });

    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("super-secret-api-key-12345");
    expect(line).toContain("eth-mainnet.example.com");
  });

  // Phase 5.8 regression tests for a real gap caught during the master
  // integration audit: the old whole-string-only URL check
  // (`^scheme://...$`) missed a URL embedded mid-string, and the top-level
  // `message` argument was never redacted at all, regardless of what it
  // contained.
  it("REGRESSION: redacts a URL's credentials even when embedded mid-string within a field value, not just when the field IS the URL", () => {
    logger.warn("provider failed", {
      component: "test",
      detail: `request to https://eth-mainnet.example.com/v2/super-secret-api-key-12345 failed: timeout`,
    });

    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("super-secret-api-key-12345");
    expect(line).toContain("eth-mainnet.example.com");
    expect(line).toContain("failed: timeout"); // surrounding text preserved, not just the URL
  });

  it("REGRESSION: redacts a URL's credentials embedded in the top-level message argument itself, not just in fields", () => {
    logger.error(`fetch failed: https://eth-mainnet.example.com/v2/super-secret-api-key-12345`, { component: "test" });

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("super-secret-api-key-12345");
    expect(line).toContain("eth-mainnet.example.com");
  });

  it("leaves an ordinary, non-URL message and field values completely unchanged", () => {
    logger.info("volume indexed", { component: "test", pool: "uniswap-v2-eth-usdc-weth", outcome: "success" });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("volume indexed");
    expect(line).toContain("uniswap-v2-eth-usdc-weth");
    expect(line).toContain("success");
  });

  it("does not throw when a field is a bigint, and still shows its value", () => {
    expect(() =>
      logger.info("scanned", { component: "test", blockNumber: BigInt(123456) }),
    ).not.toThrow();

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("123456");
  });

  it("does not throw when fields contain a circular reference", () => {
    const circular: Record<string, unknown> = { component: "test" };
    circular.self = circular;

    expect(() => logger.info("circular", circular as never)).not.toThrow();
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
