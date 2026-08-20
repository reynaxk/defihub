import { BaseError, HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";

// Distinguishes failures a retry (same or different provider) can plausibly
// fix from ones it can't, so withResilientClient doesn't waste retries on a
// request that will never succeed.
export type RpcFailureKind = "transient" | "timeout" | "rate-limit" | "malformed" | "permanent";

const RETRYABLE: ReadonlySet<RpcFailureKind> = new Set(["transient", "timeout", "rate-limit"]);

export function isRetryableRpcFailure(kind: RpcFailureKind): boolean {
  return RETRYABLE.has(kind);
}

export function classifyRpcError(err: unknown): RpcFailureKind {
  if (err instanceof TimeoutError) return "timeout";
  // viem's own class for a JSON-RPC "Limit exceeded" response (code
  // -32005) - a provider-level rate limit, same as an HTTP 429.
  if (err instanceof LimitExceededRpcError) return "rate-limit";

  if (err instanceof HttpRequestError) {
    if (err.status === 429) return "rate-limit";
    // No status at all means the request never got a response at all
    // (network failure, DNS, connection refused) rather than the provider
    // actively rejecting it - worth retrying, possibly against a different
    // provider.
    if (err.status == null) return "transient";
    if (err.status >= 500) return "transient";
    return "permanent"; // 4xx other than 429 - the request itself was rejected
  }

  // A provider that returned a well-formed JSON-RPC error object (method
  // not found, invalid params, parse error, etc.) is not going to answer
  // differently on retry - this is a configuration problem, not a
  // transient one.
  if (err instanceof RpcRequestError) return "permanent";

  // Some other viem-typed failure - e.g. an ABI decode error from a
  // response that came back but didn't match what was expected. Retrying
  // the same request against the same or another provider won't produce a
  // different shape, so this is not retry-eligible.
  if (err instanceof BaseError) return "malformed";

  // Unknown/non-viem error - default to retry-eligible rather than giving
  // up on the first unrecognized failure shape.
  return "transient";
}
