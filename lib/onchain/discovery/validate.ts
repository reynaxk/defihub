import { erc20Abi, parseAbi, type Address } from "viem";
import { backoffDelay, sleep, type BackoffOptions } from "@/lib/chains/backoff";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { logger } from "@/lib/observability/logger";
import { checkBlockHashStillCanonical, readBlockHashOnChain, type ReorgCheckResult } from "@/lib/onchain/reorg";
import { CALCULATION_SCALE } from "@/lib/onchain/volume/math";
import type { FactoryDeployment } from "./config";
import type { DecodedPairCreated } from "./scan";

// Section 6/7's validation gate: a discovered candidate is never trusted
// merely because a factory emitted an event naming it - every check below
// must pass before a pool is promoted to "active" (eligible for real
// indexing). Never "trust an arbitrary address merely because it emits
// something resembling Swap" - the checks here specifically confirm
// genuine factory lineage and a real, well-formed V2 pair interface, not
// just "this address exists."
export const PAIR_INTERFACE_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

// Eight calls per candidate, always in this order - the same "extracted
// constant every result-index calculation is keyed off of, exported so the
// batching shape is directly testable" precedent CALLS_PER_VAULT
// (verify-vault.ts) already established.
export const CALLS_PER_CANDIDATE = 8;

export function buildValidationMulticallCalls(candidates: readonly DecodedPairCreated[]) {
  return candidates.flatMap((c) => [
    { address: c.poolAddress as Address, abi: PAIR_INTERFACE_ABI, functionName: "token0" as const },
    { address: c.poolAddress as Address, abi: PAIR_INTERFACE_ABI, functionName: "token1" as const },
    { address: c.poolAddress as Address, abi: PAIR_INTERFACE_ABI, functionName: "factory" as const },
    { address: c.poolAddress as Address, abi: PAIR_INTERFACE_ABI, functionName: "getReserves" as const },
    // token0's decimals()/symbol() - filled in with the CANDIDATE's own
    // token0 address, not the pool address. If the on-chain token0() read
    // above later disagrees with what the PairCreated event claimed, the
    // whole candidate is rejected (see resolveValidationOutcome) - these
    // reads are never silently re-pointed at whatever token0() happened to
    // return. symbol() is best-effort only (Section 7's "handle symbol
    // carefully" - a real, non-negligible fraction of real ERC-20 tokens
    // return bytes32 instead of string, or omit symbol() entirely,
    // deviating from the standard ABI this call assumes) - a failed
    // symbol() read never blocks acceptance, unlike decimals(), which
    // this app's own fixed-point math genuinely depends on being correct.
    { address: c.token0 as Address, abi: erc20Abi, functionName: "decimals" as const },
    { address: c.token1 as Address, abi: erc20Abi, functionName: "decimals" as const },
    { address: c.token0 as Address, abi: erc20Abi, functionName: "symbol" as const },
    { address: c.token1 as Address, abi: erc20Abi, functionName: "symbol" as const },
  ]);
}

// Section 7's exact bound: only an integer in [0, CALCULATION_SCALE] is
// ever accepted. Rejects negative, fractional, absurd (e.g. a malformed
// RPC result decoded as some other type), and - deliberately tighter than
// a bare "valid uint8" check - any real-but-too-large decimals() value
// this app's own fixed-point volume/pricing math (math.ts's usdValueOf)
// could never safely price anyway. Catching that here, as an explicit
// discovery-time rejection with a clear reason, is more honest than
// silently accepting the pool and having every one of its swaps come back
// "unpriced" forever with no record of why.
export function isValidTokenDecimals(decimals: unknown): decimals is number {
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= CALCULATION_SCALE;
}

export interface DecodedCandidateRead {
  onchainToken0: Address | null;
  onchainToken1: Address | null;
  onchainFactory: Address | null;
  reservesCallSucceeded: boolean;
  token0Decimals: unknown;
  token1Decimals: unknown;
  // Best-effort only - see buildValidationMulticallCalls' own comment.
  // Never validated/rejected on; a null value just means "unresolved,"
  // never fabricated as some plausible-looking placeholder.
  token0Symbol: string | null;
  token1Symbol: string | null;
}

// Three-way, not a boolean accept/reject - "unavailable this run" is a
// genuinely different outcome from "genuinely, deterministically invalid,"
// and conflating them was a real bug this fix closes (CodeRabbit PR #17
// review round): a transient RPC hiccup reading the canonical-block status
// or the validation multicall must never permanently blacklist a real,
// valid pool the same way a true factory-lineage mismatch or malformed
// decimals() does. "rejected" is terminal (persisted, with a reason,
// engine.ts marks the row "rejected"); "retry" leaves the row untouched in
// "discovered" status so the exact same candidate is attempted again next
// run - the same "unknown != permanently blacklisted" distinction this
// codebase's reorg-check machinery (checkBlockHashStillCanonical's own
// three-valued "confirmed"/"reorged"/"unknown" result) already established
// for the identical class of problem.
export type ValidationOutcome =
  | { status: "accepted"; token0Decimals: number; token1Decimals: number; token0Symbol: string | null; token1Symbol: string | null }
  | { status: "rejected"; reason: string }
  | { status: "retry"; reason: string };

// Pure - the full per-candidate accept/reject/retry decision, given
// already-fetched on-chain reads and an already-resolved canonical-block
// check (never fetched inside this function itself) - the same "extract
// the pure decision, keep the RPC-touching orchestration separate and
// thin" discipline resolveVaultOutcome (verify-vault.ts) already
// established. Directly unit-testable with plain constructed inputs, no
// RPC/mocked chain client needed.
export function resolveValidationOutcome(
  deployment: FactoryDeployment,
  candidate: DecodedPairCreated,
  decoded: DecodedCandidateRead,
  canonicalStatus: "confirmed" | "reorged" | "unknown",
): ValidationOutcome {
  // Section 9: a discovered pool is never promoted based on a creation
  // event that cannot be confirmed canonical. "reorged" is a genuine,
  // terminal fact (the event was orphaned) - rejected, though the
  // recordDiscoveredPools upsert lets it self-heal automatically if the
  // real canonical creation for the same pool address is later
  // re-discovered (see that function's own comment). "unknown" (a
  // transient RPC failure reading the CURRENT block hash to compare
  // against) proves nothing either way about this candidate - it is never
  // treated as a rejection, only as "try again next run."
  if (canonicalStatus === "reorged") {
    return {
      status: "rejected",
      reason: `creation block ${candidate.blockNumber} is no longer canonical for this chain - the PairCreated event this pool was discovered from was orphaned by a reorg`,
    };
  }
  if (canonicalStatus === "unknown") {
    return {
      status: "retry",
      reason: `could not confirm creation block ${candidate.blockNumber} is still canonical (RPC read failed) - will retry`,
    };
  }

  if (!decoded.onchainFactory) {
    return { status: "rejected", reason: "factory() read failed - pool contract may not exist or does not implement the expected interface" };
  }
  if (decoded.onchainFactory.toLowerCase() !== deployment.factoryAddress.toLowerCase()) {
    return {
      status: "rejected",
      reason: `pool.factory() (${decoded.onchainFactory}) does not match the configured factory (${deployment.factoryAddress}) - this pool was not genuinely deployed by the trusted factory, never accepted merely because a PairCreated-shaped event named it`,
    };
  }

  if (!decoded.onchainToken0 || !decoded.onchainToken1) {
    return { status: "rejected", reason: "token0()/token1() read failed - pool contract does not implement the expected V2 pair interface" };
  }
  if (decoded.onchainToken0.toLowerCase() !== candidate.token0.toLowerCase() || decoded.onchainToken1.toLowerCase() !== candidate.token1.toLowerCase()) {
    return {
      status: "rejected",
      reason: `pool.token0()/token1() (${decoded.onchainToken0}/${decoded.onchainToken1}) do not match the PairCreated event's own claimed tokens (${candidate.token0}/${candidate.token1}) - the event and the pool's own live state disagree`,
    };
  }

  if (!decoded.reservesCallSucceeded) {
    return { status: "rejected", reason: "getReserves() call failed - not a well-formed V2 pair contract" };
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

// Pure - slices one candidate's own CALLS_PER_CANDIDATE-wide window out of
// a whole-batch multicall result array at the given candidate index. The
// single place both validateDiscoveredPoolsBatch and (via delegation)
// validateDiscoveredPool decode a multicall response, so the two can never
// silently drift into decoding the 8-call shape differently.
function decodeCandidateReadAt(results: { status: "success" | "failure"; result?: unknown }[], index: number): DecodedCandidateRead {
  const base = index * CALLS_PER_CANDIDATE;
  return {
    onchainToken0: results[base]?.status === "success" ? (results[base].result as Address) : null,
    onchainToken1: results[base + 1]?.status === "success" ? (results[base + 1].result as Address) : null,
    onchainFactory: results[base + 2]?.status === "success" ? (results[base + 2].result as Address) : null,
    reservesCallSucceeded: results[base + 3]?.status === "success",
    token0Decimals: results[base + 4]?.status === "success" ? results[base + 4].result : undefined,
    token1Decimals: results[base + 5]?.status === "success" ? results[base + 5].result : undefined,
    token0Symbol: results[base + 6]?.status === "success" && typeof results[base + 6].result === "string" ? (results[base + 6].result as string) : null,
    token1Symbol: results[base + 7]?.status === "success" && typeof results[base + 7].result === "string" ? (results[base + 7].result as string) : null,
  };
}

// Phase 5.11 fix: a live-confirmed false rejection. A per-sub-call failure
// WITHIN an otherwise-successful multicall (the shape multicall3's own
// `allowFailure: true` design surfaces, not a thrown/transport error) was
// always treated as a deterministic, terminal fact by resolveValidationOutcome
// - "factory() read failed" -> rejected, no different from a contract that
// genuinely doesn't implement the interface. Live-reproduced during this
// phase's own development against a real, freshly-discovered PancakeSwap V2
// pool: the multicall's own factory() sub-call came back "failure", so the
// pool was rejected - but calling factory() directly immediately afterward
// (both through the SAME RPC endpoint and cross-checked through a
// completely different, independent provider) returned the exact real,
// canonical PancakeSwap V2 Factory address. The contract was never
// malformed. Root cause, narrowed down across two separate live
// reproductions this same phase: the first showed a brief read-after-write
// gap for a contract created moments earlier in the very same run
// (discovery and validation can run back-to-back for a freshly-discovered
// candidate); a second, more severe reproduction (13/13 candidates in one
// page all rejected the same way) coincided with the SAME provider
// returning an explicit "Public endpoint rate limit" error on direct
// follow-up calls - a decentralized RPC aggregator's free tier under
// sustained load, not a per-contract timing fluke. Multicall3's own
// aggregate3 pattern gives no way to distinguish these two causes from
// inside one decoded sub-call result (a reverted call and a rate-limited
// call both just come back `status: "failure"`, with no reason payload
// surfaced) - this retry treats both the same way, on the theory that
// EITHER cause is plausibly resolved by waiting and asking again, while a
// genuinely malformed contract is not, and still ends up correctly
// rejected once the bounded budget below is exhausted. Not a scenario the
// pre-existing canonical-block-only retry logic (Phase 5.10's own
// accepted/rejected/retry redesign) covered, since that only guards the
// CREATION EVENT'S canonicality, not the pool's own required-field reads.
//
// `token0Symbol`/`token1Symbol` are deliberately excluded - best-effort
// only (see buildValidationMulticallCalls' own comment), never validated or
// retried on.
function hasIncompleteRequiredFields(decoded: DecodedCandidateRead): boolean {
  return decoded.onchainFactory == null || decoded.onchainToken0 == null || decoded.onchainToken1 == null || !decoded.reservesCallSucceeded;
}

// Bounded: up to this many EXTRA multicall attempts (beyond the first) for
// candidates whose required-field reads came back incomplete - a genuinely
// malformed contract fails identically every attempt and is still
// correctly rejected once this budget is exhausted. The backoff window is
// sized for the RATE-LIMIT cause specifically (see this function's own
// comment above) - a request-volume-based throttle needs real wall-clock
// time to reset, not just a quick retry, so this is deliberately more
// generous than a typical transient-network retry (contrast
// SHRINK_BACKOFF-style windows elsewhere in this app, sized for a single
// dropped request). Still bounded (Section 21's "no infinite retry
// loops") - candidates still incomplete after this budget flow through to
// resolveValidationOutcome exactly as before, using whatever the LAST
// attempt decoded. Only ever adds latency for the (typically small)
// subset of a page with an incomplete first decode - a page where every
// candidate decoded cleanly never touches this budget at all.
const MAX_DECODE_RETRY_ATTEMPTS = 3;
const DECODE_RETRY_BACKOFF: BackoffOptions = { baseDelayMs: 500, maxDelayMs: 5000 };

// Re-multicalls ONLY the candidates whose decode is still incomplete (never
// the whole page again - most candidates in a real batch succeed on the
// first attempt, and re-querying them too would be pure waste), merging
// each retry's own decode back into `decodedResults` by reference. A
// retry-multicall THROW (a genuine transport/provider failure, distinct
// from a per-sub-call "failure" status) stops the retry loop early rather
// than treating it as "no improvement, try again" - the already-decoded
// (incomplete) result for those candidates is left as-is and flows through
// to resolveValidationOutcome unchanged, the same outcome as before this
// fix existed.
async function retryIncompleteDecodes(deployment: FactoryDeployment, candidates: readonly DecodedPairCreated[], decodedResults: DecodedCandidateRead[]): Promise<void> {
  let pendingIndexes = candidates.map((_, i) => i).filter((i) => hasIncompleteRequiredFields(decodedResults[i]));

  for (let attempt = 1; attempt <= MAX_DECODE_RETRY_ATTEMPTS && pendingIndexes.length > 0; attempt++) {
    await sleep(backoffDelay(attempt, DECODE_RETRY_BACKOFF));

    const retryCandidates = pendingIndexes.map((i) => candidates[i]);
    let retryResults: { status: "success" | "failure"; result?: unknown }[];
    try {
      const retryCalls = buildValidationMulticallCalls(retryCandidates);
      retryResults = await withResilientClient(deployment.chainSlug, (client) => client.multicall({ contracts: retryCalls, allowFailure: true }));
    } catch {
      break; // transport-level failure - stop retrying, leave the last known decode as-is
    }

    const stillPending: number[] = [];
    for (let j = 0; j < pendingIndexes.length; j++) {
      const originalIndex = pendingIndexes[j];
      const retryDecoded = decodeCandidateReadAt(retryResults, j);
      decodedResults[originalIndex] = retryDecoded;
      if (hasIncompleteRequiredFields(retryDecoded)) {
        stillPending.push(originalIndex);
      } else {
        logger.info("pool discovery: a required-field validation read that initially failed succeeded on retry - a real pool, not rejected", {
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

// RPC-touching orchestration for a WHOLE PAGE of candidates: exactly ONE
// multicall round-trip covering every candidate's own CALLS_PER_CANDIDATE
// reads (buildValidationMulticallCalls already flattens candidates this
// way), rather than one multicall PER candidate. This is the real
// production path engine.ts's validatePendingPools calls - previously that
// function called the single-candidate validateDiscoveredPool once per
// pending row in a sequential loop, which meant a page of
// VALIDATION_BATCH_SIZE (25) candidates cost 25 separate RPC round-trips
// (each paying its own network latency) instead of one - a real,
// measurable wall-clock and RPC-count cost that only gets worse as this
// phase grows the pending-candidate backlog. Every other batched on-chain
// read in this app (verify-pool.ts, verify-vault.ts, the pricing engine)
// already uses exactly this "one multicall per page" shape; this brings
// discovery validation in line with that established convention instead of
// being the one exception.
//
// `canonicalCheckCache` is an optional, caller-owned Map shared across the
// whole page (engine.ts's validatePendingPools creates ONE per run) -
// keyed on `${blockNumber}:${blockHash}`, the exact same cache-key shape
// lib/onchain/volume/reorg.ts's own runRecheckWorkflow already established
// for the identical problem: multiple candidates discovered in the same
// block (a real, observed pattern live - several pairs created in one
// block during a busy period) would otherwise trigger one redundant
// checkBlockHashStillCanonical/readBlockHash RPC round-trip EACH for what
// is provably the same answer.
//
// A whole-multicall failure (network blip, rate limit, provider outage)
// proves nothing about any individual candidate's validity - every
// candidate in the page gets "retry", never "rejected", for the same
// reason a single candidate's own multicall failure does below - a
// transient RPC hiccup must never permanently blacklist a real, valid pool
// just because it happened to share a page with others.
export async function validateDiscoveredPoolsBatch(
  deployment: FactoryDeployment,
  candidates: readonly DecodedPairCreated[],
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

  let decodedResults: DecodedCandidateRead[];
  try {
    const calls = buildValidationMulticallCalls(candidates);
    const results = await withResilientClient(deployment.chainSlug, (client) => client.multicall({ contracts: calls, allowFailure: true }));
    decodedResults = candidates.map((_, i) => decodeCandidateReadAt(results, i));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return candidates.map(() => ({ status: "retry" as const, reason: `on-chain validation read failed: ${message}` }));
  }

  // See retryIncompleteDecodes' own comment - live-confirmed false
  // rejections from per-sub-call multicall failures that succeed on a
  // direct retry (a decentralized RPC aggregator's own read-after-write
  // lag for a just-created contract, not a genuinely malformed pool).
  await retryIncompleteDecodes(deployment, candidates, decodedResults);

  return candidates.map((candidate, i) => resolveValidationOutcome(deployment, candidate, decodedResults[i], canonicalChecks[i].status));
}

// Single-candidate convenience wrapper around validateDiscoveredPoolsBatch
// (a one-element batch) - kept for direct testability (constructing one
// candidate is simpler than a whole page) and for any caller that
// genuinely only has one candidate to check. Delegating rather than
// keeping a second, hand-duplicated decode path guarantees the two can
// never silently diverge in behavior.
export async function validateDiscoveredPool(
  deployment: FactoryDeployment,
  candidate: DecodedPairCreated,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null> = readBlockHashOnChain,
  canonicalCheckCache?: Map<string, Promise<ReorgCheckResult>>,
): Promise<ValidationOutcome> {
  const [outcome] = await validateDiscoveredPoolsBatch(deployment, [candidate], readBlockHash, canonicalCheckCache);
  return outcome;
}
