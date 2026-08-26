// Pure unit tests for RPC failure classification - no network, no viem
// client. Phase 5.5 adds the "range-limit" category on top of the
// existing transient/timeout/rate-limit/malformed/permanent set built in
// earlier phases.
import { BaseError, HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";
import { describe, expect, it } from "vitest";
import { classifyRpcError, isRetryableRpcFailure } from "./rpc-errors";

describe("classifyRpcError - range-limit detection", () => {
  it("classifies the real, live-observed publicnode archive-window rejection as range-limit, not permanent", () => {
    const err = new RpcRequestError({
      body: {},
      error: { code: -32602, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode" },
      url: "https://ethereum-rpc.publicnode.com",
    });
    expect(classifyRpcError(err)).toBe("range-limit");
  });

  it("classifies a generic 'block range' rejection as range-limit", () => {
    const err = new RpcRequestError({ body: {}, error: { code: -32000, message: "block range is too large" }, url: "https://x" });
    expect(classifyRpcError(err)).toBe("range-limit");
  });

  it("classifies Infura's classic 'query returned more than N results' as range-limit", () => {
    const err = new RpcRequestError({ body: {}, error: { code: -32005, message: "query returned more than 10000 results" }, url: "https://x" });
    expect(classifyRpcError(err)).toBe("range-limit");
  });

  it("classifies an HTTP-shaped range rejection as range-limit too, not just JSON-RPC-shaped ones", () => {
    const err = new HttpRequestError({ url: "https://x", status: 400, details: "range exceeds maximum block range of 2000" });
    expect(classifyRpcError(err)).toBe("range-limit");
  });

  it("never confuses viem's own request-rate LimitExceededRpcError with a block-range limit", () => {
    const err = new LimitExceededRpcError(new Error("limit exceeded"));
    expect(classifyRpcError(err)).toBe("rate-limit");
  });

  it("still classifies an ordinary well-formed JSON-RPC error (no range wording) as permanent", () => {
    const err = new RpcRequestError({ body: {}, error: { code: -32601, message: "method not found" }, url: "https://x" });
    expect(classifyRpcError(err)).toBe("permanent");
  });

  it("range-limit is not retryable at the RPC-client layer - only a caller that changes the range can fix it", () => {
    expect(isRetryableRpcFailure("range-limit")).toBe(false);
  });
});

describe("classifyRpcError - existing categories, unaffected by the range-limit addition", () => {
  it("still treats a TimeoutError as retryable", () => {
    expect(classifyRpcError(new TimeoutError({ body: {}, url: "https://x" }))).toBe("timeout");
  });

  it("still treats HTTP 429 as rate-limit", () => {
    expect(classifyRpcError(new HttpRequestError({ url: "https://x", status: 429 }))).toBe("rate-limit");
  });

  it("still treats HTTP 408 as timeout", () => {
    expect(classifyRpcError(new HttpRequestError({ url: "https://x", status: 408 }))).toBe("timeout");
  });

  it("still treats a connectionless HTTP failure as transient", () => {
    expect(classifyRpcError(new HttpRequestError({ url: "https://x" }))).toBe("transient");
  });

  it("still treats HTTP 5xx as transient", () => {
    expect(classifyRpcError(new HttpRequestError({ url: "https://x", status: 503 }))).toBe("transient");
  });

  it("still treats an ordinary 4xx (no range wording) as permanent", () => {
    expect(classifyRpcError(new HttpRequestError({ url: "https://x", status: 400 }))).toBe("permanent");
  });

  it("still treats an unrecognized BaseError as malformed", () => {
    expect(classifyRpcError(new BaseError("could not decode response"))).toBe("malformed");
  });

  it("still defaults an unrecognized non-viem error to transient", () => {
    expect(classifyRpcError(new Error("something odd"))).toBe("transient");
  });

  it("walks a wrapped cause chain to find the real underlying failure (unchanged)", () => {
    const inner = new HttpRequestError({ url: "https://x", status: 429 });
    const outer = new BaseError("contract call failed", { cause: inner });
    expect(classifyRpcError(outer)).toBe("rate-limit");
  });

  it("walks a wrapped cause chain to find a range-limit failure buried inside it", () => {
    const inner = new RpcRequestError({ body: {}, error: { code: -32602, message: "archive node required for this range" }, url: "https://x" });
    const outer = new BaseError("contract call failed", { cause: inner });
    expect(classifyRpcError(outer)).toBe("range-limit");
  });
});
