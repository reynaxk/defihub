// Shared exponential-backoff primitives - extracted from
// rpc-resilient-client.ts (which owned this logic alone until Phase 5.5)
// so lib/indexing/events.ts's own chunk-level retry loop (range-limit
// shrink-and-retry) can reuse the identical delay curve instead of
// hand-rolling a second one. Section 48's "avoid duplicated retry logic"
// applies here directly - one backoff implementation, two callers.

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

// Full-jitter exponential backoff: a random delay between 50% and 100% of
// the exponential value, rather than the exact exponential figure every
// time - spreads out retries from concurrent requests instead of having
// them all hammer the provider again at the exact same moment.
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
