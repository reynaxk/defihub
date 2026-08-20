import { createPublicClient, http, type PublicClient } from "viem";
import { VIEM_CHAIN_BY_SLUG, rpcUrlsFor } from "./rpc-client";
import { classifyRpcError, isRetryableRpcFailure, type RpcFailureKind } from "./rpc-errors";

export interface RpcAttempt {
  url: string;
  kind: RpcFailureKind;
  message: string;
}

export class RpcUnavailableError extends Error {
  constructor(
    public readonly chainSlug: string,
    public readonly attempts: RpcAttempt[],
  ) {
    super(
      `[rpc:${chainSlug}] all configured providers failed after ${attempts.length} attempt(s): ` +
        attempts.map((a) => `${a.url} (${a.kind}: ${a.message})`).join("; "),
    );
    this.name = "RpcUnavailableError";
  }
}

// Bounded, not unlimited - a chain with a genuinely broken RPC (or none
// configured) must fail loudly and promptly, not hang retrying forever.
const MAX_RETRIES_PER_PROVIDER = 2; // total attempts per provider = 1 + this
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

// Full-jitter exponential backoff: a random delay between 50% and 100% of
// the exponential value, rather than the exact exponential figure every
// time - spreads out retries from concurrent requests instead of having
// them all hammer the provider again at the exact same moment.
function backoffDelay(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Deliberately narrow: only the read-shaped methods this app's consumers
// actually use. This app performs no writes/signing anywhere (confirmed by
// audit), and this type is the enforcement of that - there is no generic
// "send anything" escape hatch, so reusing this wrapper for a future write
// path would require a conscious, separate decision rather than an
// accidental one. getLogs was added alongside the event-ingestion
// primitives (lib/indexing/events.ts) - still strictly a read.
export type ReadClient = Pick<
  PublicClient,
  "readContract" | "multicall" | "getBalance" | "getBlockNumber" | "getLogs"
>;

// Runs `fn` against each configured RPC provider for `chainSlug` in order
// (primary, then any operator-configured fallback - see rpcUrlsFor).
// Retry-eligible failures (transient/timeout/rate-limit) get a bounded,
// backed-off retry on the SAME provider before moving on; malformed/
// permanent failures skip straight to the next provider, since retrying a
// configuration problem wastes time without changing the outcome.
// Read-only throughout - see ReadClient above.
export async function withResilientClient<T>(
  chainSlug: string,
  fn: (client: ReadClient) => Promise<T>,
): Promise<T> {
  const viemChain = VIEM_CHAIN_BY_SLUG.get(chainSlug);
  if (!viemChain) throw new Error(`withResilientClient: no viem chain definition for "${chainSlug}"`);

  const attempts: RpcAttempt[] = [];

  for (const url of rpcUrlsFor(chainSlug)) {
    const client = createPublicClient({ chain: viemChain, transport: http(url) });

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      try {
        return await fn(client);
      } catch (err) {
        const kind = classifyRpcError(err);
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ url, kind, message });

        const isLastAttemptForThisProvider = attempt === MAX_RETRIES_PER_PROVIDER;
        if (!isRetryableRpcFailure(kind) || isLastAttemptForThisProvider) break;
        await sleep(backoffDelay(attempt));
      }
    }
  }

  throw new RpcUnavailableError(chainSlug, attempts);
}
