import { BaseError, HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";

// Distinguishes failures a retry (same or different provider) can plausibly
// fix from ones it can't, so withResilientClient doesn't waste retries on a
// request that will never succeed.
//
// "range-limit" (Phase 5.5): a provider refused a request specifically
// because of the SIZE of the requested block range (eth_getLogs/eth_call
// historical reads), not because the provider is down or the request is
// otherwise malformed. Distinct from "permanent" on purpose - a range-limit
// failure is fully recoverable by asking for a SMALLER range (see
// lib/indexing/events.ts's adaptive chunk-shrinking), whereas "permanent"
// means no retry of any shape will ever help (bad method, bad chain
// config). Not retryable at THIS layer (retrying the identical oversized
// request against the same or a different provider won't help - see
// isRetryableRpcFailure below) - only a caller that actually changes the
// range can turn this into success, which is exactly what
// lib/indexing/events.ts's scanFromCursor now does.
export type RpcFailureKind = "transient" | "timeout" | "rate-limit" | "range-limit" | "malformed" | "permanent";

const RETRYABLE: ReadonlySet<RpcFailureKind> = new Set(["transient", "timeout", "rate-limit"]);

export function isRetryableRpcFailure(kind: RpcFailureKind): boolean {
  return RETRYABLE.has(kind);
}

// Best-effort text matching, not a guaranteed-perfect classifier - there is
// no standardized JSON-RPC error CODE across providers for "your block
// range is too large" (unlike 429 for rate limiting, which is a real HTTP
// status). Every phrase here was chosen to be a GENERIC signal a range-size
// rejection tends to use across multiple real providers (Alchemy, Infura,
// QuickNode, publicnode), not a single provider's exact wording - Section
// 22/23's own "do not hardcode one provider's window as a universal rule"
// applies to the DETECTION text too, not just the numeric limit. A message
// that doesn't match any of these simply falls through to this function's
// existing classification (permanent/malformed) exactly as before - this
// can only ever narrow "permanent" down into a more specific, more useful
// category, never make a previously-retryable failure stop being retried.
const RANGE_LIMIT_PATTERN =
  /\barchive\b|block range|range (is )?too (large|wide|big)|exceeds (the )?(max(imum)?\s*)?(block\s*)?range|query returned more than|too many blocks|range exceeds|10,?000 (results|blocks)|personal token/i;

function looksLikeRangeLimit(message: string): boolean {
  return RANGE_LIMIT_PATTERN.test(message);
}

function classifyOne(err: unknown): RpcFailureKind | null {
  if (err instanceof TimeoutError) return "timeout";
  // viem's own class for a JSON-RPC "Limit exceeded" response (code
  // -32005) - a provider-level REQUEST-rate limit, same as an HTTP 429.
  // Checked by class, not text, so it can never be confused with the
  // block-RANGE limit above even though both might use the word "limit".
  if (err instanceof LimitExceededRpcError) return "rate-limit";

  if (err instanceof HttpRequestError) {
    if (looksLikeRangeLimit(err.message)) return "range-limit";
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
  // transient one. Checked for the range-limit text FIRST: this app's own
  // live-observed case (publicnode's "Archive requests require a personal
  // token", JSON-RPC code -32602 "Invalid params") arrives as exactly this
  // error type - without this check it would fall through to the generic
  // "permanent" bucket below and be indistinguishable from a genuine
  // misconfiguration.
  if (err instanceof RpcRequestError) {
    if (looksLikeRangeLimit(err.message)) return "range-limit";
    return "permanent";
  }

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
