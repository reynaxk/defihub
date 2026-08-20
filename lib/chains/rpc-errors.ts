import { BaseError, HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";

// Distinguishes failures a retry (same or different provider) can plausibly
// fix from ones it can't, so withResilientClient doesn't waste retries on a
// request that will never succeed.
export type RpcFailureKind = "transient" | "timeout" | "rate-limit" | "malformed" | "permanent";

const RETRYABLE: ReadonlySet<RpcFailureKind> = new Set(["transient", "timeout", "rate-limit"]);

export function isRetryableRpcFailure(kind: RpcFailureKind): boolean {
  return RETRYABLE.has(kind);
}

function classifyOne(err: unknown): RpcFailureKind | null {
  if (err instanceof TimeoutError) return "timeout";
  // viem's own class for a JSON-RPC "Limit exceeded" response (code
  // -32005) - a provider-level rate limit, same as an HTTP 429.
  if (err instanceof LimitExceededRpcError) return "rate-limit";

  if (err instanceof HttpRequestError) {
    if (err.status === 429) return "rate-limit";
    // 408 Request Timeout means the server gave up waiting for the
    // request, not that it rejected it as malformed/invalid - the same
    // request plausibly succeeds on a retry or a different provider, so
    // this must be classified before the generic 4xx branch below (which
    // would otherwise treat it as permanent).
    if (err.status === 408) return "timeout";
    // No status at all means the request never got a response at all
    // (network failure, DNS, connection refused) rather than the provider
    // actively rejecting it - worth retrying, possibly against a different
    // provider.
    if (err.status == null) return "transient";
    if (err.status >= 500) return "transient";
    return "permanent"; // 4xx other than 429/408 - the request itself was rejected
  }

  // A provider that returned a well-formed JSON-RPC error object (method
  // not found, invalid params, parse error, etc.) is not going to answer
  // differently on retry - this is a configuration problem, not a
  // transient one.
  if (err instanceof RpcRequestError) return "permanent";

  return null;
}

export function classifyRpcError(err: unknown): RpcFailureKind {
  // readContract/multicall wrap the underlying transport failure inside a
  // ContractFunctionExecutionError (or similar) rather than throwing it
  // directly - walking the .cause chain finds the real
  // HttpRequestError/TimeoutError/etc underneath instead of misclassifying
  // every wrapped transient failure as "malformed" (non-retryable) just
  // because the outer error type didn't match.
  if (err instanceof BaseError) {
    const walked = err.walk((e) => classifyOne(e) != null);
    const kind = walked ? classifyOne(walked) : null;
    if (kind) return kind;

    // Some other viem-typed failure with no retryable cause anywhere in
    // its chain - e.g. an ABI decode error from a response that came back
    // but didn't match what was expected. Retrying the same request
    // against the same or another provider won't produce a different
    // shape, so this is not retry-eligible.
    return "malformed";
  }

  // Unknown/non-viem error - default to retry-eligible rather than giving
  // up on the first unrecognized failure shape.
  return "transient";
}
