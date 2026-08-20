import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc-client", () => ({
  VIEM_CHAIN_BY_SLUG: new Map([
    ["testchain", {}],
    ["secretchain", {}],
  ]),
  rpcUrlsFor: (slug: string) => {
    if (slug === "testchain") return ["https://primary.invalid", "https://secondary.invalid"];
    if (slug === "secretchain") return ["https://rpc.invalid/v2/super-secret-api-key-12345"];
    return [];
  },
}));

const createPublicClientMock = vi.fn();
vi.mock("viem", async (importActual) => {
  const actual = await importActual<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (...args: unknown[]) => createPublicClientMock(...args),
  };
});

import { BaseError, HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";
import { RpcUnavailableError, withResilientClient } from "./rpc-resilient-client";

function fakeClient(getBalance: ReturnType<typeof vi.fn>) {
  return { getBalance, multicall: vi.fn(), readContract: vi.fn(), getBlockNumber: vi.fn() };
}

// Every retry path below sleeps between attempts (backoffDelay) - fake
// timers let those tests assert real retry-count/failover behavior without
// the suite actually waiting out the backoff in wall-clock time.
describe("withResilientClient", () => {
  beforeEach(() => {
    createPublicClientMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result when the primary provider succeeds on the first try", async () => {
    const getBalance = vi.fn().mockResolvedValue(BigInt(100));
    createPublicClientMock.mockReturnValueOnce(fakeClient(getBalance));

    const result = await withResilientClient("testchain", (client) => client.getBalance({} as never));

    expect(result).toBe(BigInt(100));
    expect(createPublicClientMock).toHaveBeenCalledTimes(1);
    expect(getBalance).toHaveBeenCalledTimes(1);
  });

  it("fails over to the secondary provider when the primary is exhausted on a retryable error", async () => {
    const primaryBalance = vi.fn().mockRejectedValue(new Error("connection refused"));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(200));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(BigInt(200));
    // Default-classified-transient error retries twice more on the same
    // provider (3 total attempts) before failing over.
    expect(primaryBalance).toHaveBeenCalledTimes(3);
    expect(secondaryBalance).toHaveBeenCalledTimes(1);
  });

  it("throws RpcUnavailableError with every attempt recorded when all providers fail", async () => {
    const failing = () => fakeClient(vi.fn().mockRejectedValue(new Error("still down")));
    createPublicClientMock.mockReturnValueOnce(failing()).mockReturnValueOnce(failing());

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    const assertion = expect(resultPromise).rejects.toThrow(RpcUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("retries a retryable failure up to the bound, then moves on (retry-exhaustion count)", async () => {
    const primaryBalance = vi.fn().mockRejectedValue(new Error("transient-ish"));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(primaryBalance).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("treats a TimeoutError as retryable", async () => {
    const primaryBalance = vi
      .fn()
      .mockRejectedValue(new TimeoutError({ body: {}, url: "https://primary.invalid" }));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(BigInt(1));
    expect(primaryBalance).toHaveBeenCalledTimes(3);
  });

  it("treats an HTTP 429 as a rate-limit failure and retries it", async () => {
    const primaryBalance = vi
      .fn()
      .mockRejectedValue(new HttpRequestError({ url: "https://primary.invalid", status: 429 }));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(BigInt(1));
    expect(primaryBalance).toHaveBeenCalledTimes(3);
  });

  it("treats viem's own rate-limit RPC error the same way", async () => {
    const cause = new Error("limit exceeded");
    const primaryBalance = vi.fn().mockRejectedValue(new LimitExceededRpcError(cause));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const resultPromise = withResilientClient("testchain", (client) => client.getBalance({} as never));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(BigInt(1));
  });

  it("does not retry a permanent (non-429 4xx) failure - fails over to the next provider immediately", async () => {
    const primaryBalance = vi
      .fn()
      .mockRejectedValue(new HttpRequestError({ url: "https://primary.invalid", status: 400 }));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const result = await withResilientClient("testchain", (client) => client.getBalance({} as never));

    expect(result).toBe(BigInt(1));
    expect(primaryBalance).toHaveBeenCalledTimes(1); // no retry - straight to the next provider
  });

  it("does not retry a well-formed JSON-RPC error response - fails over immediately", async () => {
    const primaryBalance = vi.fn().mockRejectedValue(
      new RpcRequestError({
        body: {},
        error: { code: -32601, message: "method not found" },
        url: "https://primary.invalid",
      }),
    );
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const result = await withResilientClient("testchain", (client) => client.getBalance({} as never));

    expect(result).toBe(BigInt(1));
    expect(primaryBalance).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed-response-shaped error - fails over immediately", async () => {
    const primaryBalance = vi.fn().mockRejectedValue(new BaseError("could not decode response"));
    const secondaryBalance = vi.fn().mockResolvedValue(BigInt(1));
    createPublicClientMock
      .mockReturnValueOnce(fakeClient(primaryBalance))
      .mockReturnValueOnce(fakeClient(secondaryBalance));

    const result = await withResilientClient("testchain", (client) => client.getBalance({} as never));

    expect(result).toBe(BigInt(1));
    expect(primaryBalance).toHaveBeenCalledTimes(1);
  });

  it("never leaks the full RPC URL (which may embed a provider API key) in the thrown error", async () => {
    const failing = fakeClient(
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED https://rpc.invalid/v2/super-secret-api-key-12345")),
    );
    createPublicClientMock.mockReturnValueOnce(failing);

    const resultPromise = withResilientClient("secretchain", (client) => client.getBalance({} as never));
    const assertion = expect(resultPromise).rejects.toThrow(RpcUnavailableError);
    await vi.runAllTimersAsync();

    try {
      await resultPromise;
      expect.unreachable("expected withResilientClient to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcUnavailableError);
      const unavailable = err as RpcUnavailableError;
      expect(unavailable.message).not.toContain("super-secret-api-key-12345");
      expect(unavailable.attempts[0].url).not.toContain("super-secret-api-key-12345");
      expect(unavailable.attempts[0].message).not.toContain("super-secret-api-key-12345");
      expect(unavailable.attempts[0].url).toBe("https://rpc.invalid");
    }
    await assertion;
  });

  it("throws immediately for a chain with no viem chain definition", async () => {
    await expect(withResilientClient("unknown-chain", (client) => client.getBalance({} as never))).rejects.toThrow(
      /no viem chain definition/,
    );
    expect(createPublicClientMock).not.toHaveBeenCalled();
  });
});
