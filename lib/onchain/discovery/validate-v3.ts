import { erc20Abi, parseAbi, type Address } from "viem";
import { backoffDelay, sleep, type BackoffOptions } from "@/lib/chains/backoff";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { logger } from "@/lib/observability/logger";
import { checkBlockHashStillCanonical, readBlockHashOnChain, type ReorgCheckResult } from "@/lib/onchain/reorg";
import type { UniswapV3FactoryDeployment } from "./config";
import type { DecodedPoolCreated } from "./scan";
import { isValidTokenDecimals, type ValidationOutcome } from "./validate";

// Phase 5.11's V3 discovery validation - a deliberate SIBLING to validate.ts
// (V2), not a unification of the two. V3 pools genuinely implement a
// different interface (no getReserves(), and fee is a per-pool fact this
// module must cross-check rather than a deployment-level config constant
// V2 trusts outright) - matching this codebase's own established
// precedent for the identical V2/V3 split at the volume-indexing layer
// (lib/onchain/volume/uniswap-v2.ts vs uniswap-v3.ts, dispatched by
// lib/onchain/volume/engine.ts's own small sourceKind switch, not one
// mega-function forcing both shapes together). The retry-loop SHAPE below
// duplicates validate.ts's retryIncompleteDecodes structurally (bounded
// attempts, same backoff window, same "leave the last decode as-is on a
// transport failure" contract) rather than generalizing it behind a
// parameterized helper - exactly two concrete call sites (V2, V3) is not
// enough to justify that abstraction yet, and the duplicated shape here is
// small and self-contained.
export const V3_POOL_INTERFACE_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);

// Nine calls per candidate - one more than V2's CALLS_PER_CANDIDATE (8):
// the same token0/token1/factory/decimals/symbol reads, PLUS fee() (V2 has
// no analog - its fee is a trusted deployment constant, not read
// per-pool), with liquidity() standing in for V2's getReserves() as the
// "is this really a well-formed pool contract" check.
export const CALLS_PER_V3_CANDIDATE = 9;

export function buildV3ValidationMulticallCalls(candidates: readonly DecodedPoolCreated[]) {
  return candidates.flatMap((c) => [
    { address: c.poolAddress as Address, abi: V3_POOL_INTERFACE_ABI, functionName: "token0" as const },
    { address: c.poolAddress as Address, abi: V3_POOL_INTERFACE_ABI, functionName: "token1" as const },
    { address: c.poolAddress as Address, abi: V3_POOL_INTERFACE_ABI, functionName: "factory" as const },
    { address: c.poolAddress as Address, abi: V3_POOL_INTERFACE_ABI, functionName: "fee" as const },
    { address: c.poolAddress as Address, abi: V3_POOL_INTERFACE_ABI, functionName: "liquidity" as const },
    { address: c.token0 as Address, abi: erc20Abi, functionName: "decimals" as const },
    { address: c.token1 as Address, abi: erc20Abi, functionName: "decimals" as const },
    { address: c.token0 as Address, abi: erc20Abi, functionName: "symbol" as const },
    { address: c.token1 as Address, abi: erc20Abi, functionName: "symbol" as const },
  ]);
}

export interface DecodedV3CandidateRead {
  onchainToken0: Address | null;
  onchainToken1: Address | null;
  onchainFactory: Address | null;
  // null means the fee() call itself failed - distinct from a real,
  // successfully-read value that simply disagrees with the event's own
  // claimed feeTier (see resolveV3ValidationOutcome).
  onchainFeeTier: number | null;
  liquidityCallSucceeded: boolean;
  token0Decimals: unknown;
  token1Decimals: unknown;
  token0Symbol: string | null;
  token1Symbol: string | null;
}

function decodeV3CandidateReadAt(results: { status: "success" | "failure"; result?: unknown }[], index: number): DecodedV3CandidateRead {
  const base = index * CALLS_PER_V3_CANDIDATE;
  return {
    onchainToken0: results[base]?.status === "success" ? (results[base].result as Address) : null,
    onchainToken1: results[base + 1]?.status === "success" ? (results[base + 1].result as Address) : null,
    onchainFactory: results[base + 2]?.status === "success" ? (results[base + 2].result as Address) : null,
    onchainFeeTier: results[base + 3]?.status === "success" && typeof results[base + 3].result === "number" ? (results[base + 3].result as number) : null,
    liquidityCallSucceeded: results[base + 4]?.status === "success",
    token0Decimals: results[base + 5]?.status === "success" ? results[base + 5].result : undefined,
    token1Decimals: results[base + 6]?.status === "success" ? results[base + 6].result : undefined,
    token0Symbol: results[base + 7]?.status === "success" && typeof results[base + 7].result === "string" ? (results[base + 7].result as string) : null,
    token1Symbol: results[base + 8]?.status === "success" && typeof results[base + 8].result === "string" ? (results[base + 8].result as string) : null,
  };
}

// Pure - the V3 twin of resolveValidationOutcome (validate.ts). Same
// canonical-block-first ordering and the same accepted/rejected/retry
// three-way contract; the checks themselves differ where V3's own
// interface genuinely differs from V2's.
export function resolveV3ValidationOutcome(
  deployment: UniswapV3FactoryDeployment,
  candidate: DecodedPoolCreated,
  decoded: DecodedV3CandidateRead,
  canonicalStatus: "confirmed" | "reorged" | "unknown",
): ValidationOutcome {
  if (canonicalStatus === "reorged") {
    return {
      status: "rejected",
      reason: `creation block ${candidate.blockNumber} is no longer canonical for this chain - the PoolCreated event this pool was discovered from was orphaned by a reorg`,
    };
  }
  if (canonicalStatus === "unknown") {
    return {
      status: "retry",
      reason: `could not confirm creation block ${candidate.blockNumber} is still canonical (RPC read failed) - will retry`,
    };
  }

  if (!decoded.onchainFactory) {
    return { status: "rejected", reason: "factory() read failed - pool contract may not exist or does not implement the expected V3 interface" };
  }
  if (decoded.onchainFactory.toLowerCase() !== deployment.factoryAddress.toLowerCase()) {
    return {
      status: "rejected",
      reason: `pool.factory() (${decoded.onchainFactory}) does not match the configured factory (${deployment.factoryAddress}) - this pool was not genuinely deployed by the trusted factory, never accepted merely because a PoolCreated-shaped event named it`,
    };
  }

  if (!decoded.onchainToken0 || !decoded.onchainToken1) {
    return { status: "rejected", reason: "token0()/token1() read failed - pool contract does not implement the expected V3 pool interface" };
  }
  if (decoded.onchainToken0.toLowerCase() !== candidate.token0.toLowerCase() || decoded.onchainToken1.toLowerCase() !== candidate.token1.toLowerCase()) {
    return {
      status: "rejected",
      reason: `pool.token0()/token1() (${decoded.onchainToken0}/${decoded.onchainToken1}) do not match the PoolCreated event's own claimed tokens (${candidate.token0}/${candidate.token1}) - the event and the pool's own live state disagree`,
    };
  }

  // V3-specific: the fee tier is never trusted from the event alone, the
  // exact same "never trust the event, cross-check the pool's own live
  // state" discipline already applied to token0/token1 above and to V2's
  // factory lineage check.
  if (decoded.onchainFeeTier == null) {
    return { status: "rejected", reason: "fee() read failed - pool contract does not implement the expected V3 pool interface" };
  }
  if (decoded.onchainFeeTier !== candidate.feeTier) {
    return {
      status: "rejected",
      reason: `pool.fee() (${decoded.onchainFeeTier}) does not match the PoolCreated event's own claimed fee tier (${candidate.feeTier}) - the event and the pool's own live state disagree`,
    };
  }

  if (!decoded.liquidityCallSucceeded) {
    return { status: "rejected", reason: "liquidity() call failed - not a well-formed V3 pool contract" };
  }

  if (!isValidTokenDecimals(decoded.token0Decimals)) {
    return { status: "rejected", reason: `token0 (${candidate.token0}) decimals() returned an invalid or unreadable value: ${String(decoded.token0Decimals)}` };
  }
  if (!isValidTokenDecimals(decoded.token1Decimals)) {
    return { status: "rejected", reason: `token1 (${candidate.token1}) decimals() returned an invalid or unreadable value: ${String(decoded.token1Decimals)}` };
  }

  return {
    status: "accepted",
    token0Decimals: decoded.token0Decimals,
    token1Decimals: decoded.token1Decimals,
    token0Symbol: decoded.token0Symbol,
    token1Symbol: decoded.token1Symbol,
  };
}

// The V3 twin of validate.ts's hasIncompleteRequiredFields/
// retryIncompleteDecodes - same live-confirmed rationale (a decentralized
// RPC aggregator's per-sub-call failures within an otherwise-successful
// multicall, from either a read-after-write propagation gap or a
// free-tier rate limit, neither of which means the pool is actually
// malformed). feeTier is included as a required field here (unlike V2,
// which has no analogous per-pool value to cross-check) - a failed fee()
// read is exactly as much a "this sub-call needs a retry" signal as a
// failed factory() read.
function hasIncompleteV3RequiredFields(decoded: DecodedV3CandidateRead): boolean {
  return decoded.onchainFactory == null || decoded.onchainToken0 == null || decoded.onchainToken1 == null || decoded.onchainFeeTier == null || !decoded.liquidityCallSucceeded;
}

// The V3 twin of validate.ts's own mergeCandidateReads - same PR #19
// review-round fix, same rationale (a retry re-reads every sub-call for a
// pending candidate, so a field that already succeeded on an earlier
// attempt could come back "failure" on a later one and must never
// silently erase that earlier success). Per-field monotonic: a field's
// most recent SUCCESSFUL read wins; a field that has never succeeded
// stays unresolved.
export function mergeV3CandidateReads(previous: DecodedV3CandidateRead, next: DecodedV3CandidateRead): DecodedV3CandidateRead {
  return {
    onchainToken0: next.onchainToken0 ?? previous.onchainToken0,
    onchainToken1: next.onchainToken1 ?? previous.onchainToken1,
    onchainFactory: next.onchainFactory ?? previous.onchainFactory,
    onchainFeeTier: next.onchainFeeTier ?? previous.onchainFeeTier,
    // Monotonic OR, not overwrite - once a real liquidity() success has
    // been observed, no later attempt's failure can un-observe it.
    liquidityCallSucceeded: previous.liquidityCallSucceeded || next.liquidityCallSucceeded,
    token0Decimals: next.token0Decimals !== undefined ? next.token0Decimals : previous.token0Decimals,
    token1Decimals: next.token1Decimals !== undefined ? next.token1Decimals : previous.token1Decimals,
    token0Symbol: next.token0Symbol ?? previous.token0Symbol,
    token1Symbol: next.token1Symbol ?? previous.token1Symbol,
  };
}

const MAX_DECODE_RETRY_ATTEMPTS = 3;
const DECODE_RETRY_BACKOFF: BackoffOptions = { baseDelayMs: 500, maxDelayMs: 5000 };

async function retryIncompleteV3Decodes(deployment: UniswapV3FactoryDeployment, candidates: readonly DecodedPoolCreated[], decodedResults: DecodedV3CandidateRead[]): Promise<void> {
  let pendingIndexes = candidates.map((_, i) => i).filter((i) => hasIncompleteV3RequiredFields(decodedResults[i]));

  for (let attempt = 1; attempt <= MAX_DECODE_RETRY_ATTEMPTS && pendingIndexes.length > 0; attempt++) {
    await sleep(backoffDelay(attempt, DECODE_RETRY_BACKOFF));

    const retryCandidates = pendingIndexes.map((i) => candidates[i]);
    let retryResults: { status: "success" | "failure"; result?: unknown }[];
    try {
      const retryCalls = buildV3ValidationMulticallCalls(retryCandidates);
      retryResults = await withResilientClient(deployment.chainSlug, (client) => client.multicall({ contracts: retryCalls, allowFailure: true }));
    } catch {
      break;
    }

    const stillPending: number[] = [];
    for (let j = 0; j < pendingIndexes.length; j++) {
      const originalIndex = pendingIndexes[j];
      const retryDecoded = decodeV3CandidateReadAt(retryResults, j);
      const merged = mergeV3CandidateReads(decodedResults[originalIndex], retryDecoded);
      decodedResults[originalIndex] = merged;
      if (hasIncompleteV3RequiredFields(merged)) {
        stillPending.push(originalIndex);
      } else {
        logger.info("pool discovery: a required-field V3 validation read that initially failed succeeded on retry - a real pool, not rejected", {
          component: "onchain-discovery",
          deployment: deployment.key,
          pool: retryCandidates[j].poolAddress,
          attempt,
        });
      }
    }
    pendingIndexes = stillPending;
  }
}

// RPC-touching orchestration for a whole page of V3 candidates - the V3
// twin of validateDiscoveredPoolsBatch, same one-multicall-per-page shape
// and the same canonicalCheckCache reuse.
export async function validateV3DiscoveredPoolsBatch(
  deployment: UniswapV3FactoryDeployment,
  candidates: readonly DecodedPoolCreated[],
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null> = readBlockHashOnChain,
  canonicalCheckCache?: Map<string, Promise<ReorgCheckResult>>,
): Promise<ValidationOutcome[]> {
  if (candidates.length === 0) return [];

  const canonicalChecks = await Promise.all(
    candidates.map((candidate) => {
      const cacheKey = `${candidate.blockNumber}:${candidate.blockHash}`;
      let canonicalCheckPromise = canonicalCheckCache?.get(cacheKey);
      if (!canonicalCheckPromise) {
        canonicalCheckPromise = checkBlockHashStillCanonical(candidate.blockNumber, candidate.blockHash, (bn) => readBlockHash(deployment.chainSlug, bn));
        canonicalCheckCache?.set(cacheKey, canonicalCheckPromise);
      }
      return canonicalCheckPromise;
    }),
  );

  let decodedResults: DecodedV3CandidateRead[];
  try {
    const calls = buildV3ValidationMulticallCalls(candidates);
    const results = await withResilientClient(deployment.chainSlug, (client) => client.multicall({ contracts: calls, allowFailure: true }));
    decodedResults = candidates.map((_, i) => decodeV3CandidateReadAt(results, i));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return candidates.map(() => ({ status: "retry" as const, reason: `on-chain validation read failed: ${message}` }));
  }

  await retryIncompleteV3Decodes(deployment, candidates, decodedResults);

  return candidates.map((candidate, i) => resolveV3ValidationOutcome(deployment, candidate, decodedResults[i], canonicalChecks[i].status));
}
