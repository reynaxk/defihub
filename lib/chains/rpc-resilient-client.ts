import { createPublicClient, http, type PublicClient } from "viem";
import { backoffDelay, sleep, type BackoffOptions } from "./backoff";
import { VIEM_CHAIN_BY_SLUG, rpcUrlsFor } from "./rpc-client";
import { classifyRpcError, isRetryableRpcFailure, type RpcFailureKind } from "./rpc-errors";

export interface RpcAttempt {
  url: string;
  kind: RpcFailureKind;
  message: string;
}

// Operator-configured RPC URLs (ETHEREUM_RPC_URL, *_RPC_URL_FALLBACK - see
// rpc-client.ts) commonly embed a provider API key directly in the path
// (Alchemy/Infura-style), so the full URL must never reach a log line or an
// error surfaced to a caller. Reduced to scheme+host only - enough to tell
// providers apart in a log without leaking the credential.
function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[unparseable-rpc-url]";
  }
}

// viem's own error messages (e.g. HttpRequestError) also embed the request
// URL verbatim - redacting the exact URL string wherever it appears in the
// message, not just the field that carries it separately, covers that too.
function redactUrlInMessage(message: string, url: string): string {
  return url ? message.split(url).join(redactRpcUrl(url)) : message;
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
const BACKOFF: BackoffOptions = { baseDelayMs: 250, maxDelayMs: 4000 };

// Deliberately narrow: only the read-shaped methods this app's consumers
// actually use. This app performs no writes/signing anywhere (confirmed by
// audit), and this type is the enforcement of that - there is no generic
// "send anything" escape hatch, so reusing this wrapper for a future write
// path would require a conscious, separate decision rather than an
// accidental one. getLogs was added alongside the event-ingestion
// primitives (lib/indexing/events.ts) - still strictly a read. getBlock was
// added so a pinned block's hash (not just its number) can be captured for
// provenance - see verify-pool.ts.
export type ReadClient = Pick<
  PublicClient,
  "readContract" | "multicall" | "getBalance" | "getBlockNumber" | "getLogs" | "getBlock"
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
        attempts.push({ url: redactRpcUrl(url), kind, message: redactUrlInMessage(message, url) });

        const isLastAttemptForThisProvider = attempt === MAX_RETRIES_PER_PROVIDER;
        if (!isRetryableRpcFailure(kind) || isLastAttemptForThisProvider) break;
        await sleep(backoffDelay(attempt, BACKOFF));
      }
    }
  }

  throw new RpcUnavailableError(chainSlug, attempts);
}
