import { erc20Abi, parseAbi, type Address } from "viem";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { checkBlockHashStillCanonical, readBlockHashOnChain } from "@/lib/onchain/reorg";
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

export type ValidationOutcome =
  | { accepted: true; token0Decimals: number; token1Decimals: number; token0Symbol: string | null; token1Symbol: string | null }
  | { accepted: false; reason: string };

// Pure - the full per-candidate accept/reject decision, given already-
// fetched on-chain reads and an already-resolved canonical-block check
// (never fetched inside this function itself) - the same "extract the pure
// decision, keep the RPC-touching orchestration separate and thin"
// discipline resolveVaultOutcome (verify-vault.ts) already established.
// Directly unit-testable with plain constructed inputs, no RPC/mocked
// chain client needed.
export function resolveValidationOutcome(
  deployment: FactoryDeployment,
  candidate: DecodedPairCreated,
  decoded: DecodedCandidateRead,
  canonicalStatus: "confirmed" | "reorged" | "unknown",
): ValidationOutcome {
  // Section 9: a discovered pool is never promoted based on a creation
  // event that cannot be confirmed canonical - "unknown" (a transient RPC
  // failure reading the current block hash) is NOT treated as license to
  // proceed; it's retried next run (the row stays in "discovered" status),
  // never silently accepted.
  if (canonicalStatus !== "confirmed") {
    return {
      accepted: false,
      reason:
        canonicalStatus === "reorged"
          ? `creation block ${candidate.blockNumber} is no longer canonical for this chain - the PairCreated event this pool was discovered from was orphaned by a reorg`
          : `could not confirm creation block ${candidate.blockNumber} is still canonical (RPC read failed) - will retry`,
    };
  }

  if (!decoded.onchainFactory) {
    return { accepted: false, reason: "factory() read failed - pool contract may not exist or does not implement the expected interface" };
  }
  if (decoded.onchainFactory.toLowerCase() !== deployment.factoryAddress.toLowerCase()) {
    return {
      accepted: false,
      reason: `pool.factory() (${decoded.onchainFactory}) does not match the configured factory (${deployment.factoryAddress}) - this pool was not genuinely deployed by the trusted factory, never accepted merely because a PairCreated-shaped event named it`,
    };
  }

  if (!decoded.onchainToken0 || !decoded.onchainToken1) {
    return { accepted: false, reason: "token0()/token1() read failed - pool contract does not implement the expected V2 pair interface" };
  }
  if (decoded.onchainToken0.toLowerCase() !== candidate.token0.toLowerCase() || decoded.onchainToken1.toLowerCase() !== candidate.token1.toLowerCase()) {
    return {
      accepted: false,
      reason: `pool.token0()/token1() (${decoded.onchainToken0}/${decoded.onchainToken1}) do not match the PairCreated event's own claimed tokens (${candidate.token0}/${candidate.token1}) - the event and the pool's own live state disagree`,
    };
  }

  if (!decoded.reservesCallSucceeded) {
    return { accepted: false, reason: "getReserves() call failed - not a well-formed V2 pair contract" };
  }

  if (!isValidTokenDecimals(decoded.token0Decimals)) {
    return { accepted: false, reason: `token0 (${candidate.token0}) decimals() returned an invalid or unreadable value: ${String(decoded.token0Decimals)}` };
  }
  if (!isValidTokenDecimals(decoded.token1Decimals)) {
    return { accepted: false, reason: `token1 (${candidate.token1}) decimals() returned an invalid or unreadable value: ${String(decoded.token1Decimals)}` };
  }

  return {
    accepted: true,
    token0Decimals: decoded.token0Decimals,
    token1Decimals: decoded.token1Decimals,
    token0Symbol: decoded.token0Symbol,
    token1Symbol: decoded.token1Symbol,
  };
}

// RPC-touching orchestration for ONE candidate: reads the canonical-block
// status and the validation multicall, then hands off to
// resolveValidationOutcome for the actual decision. Bulk validation
// (engine.ts) batches the on-chain reads for a whole page of candidates
// into one multicall rather than calling this per-candidate in production
// - this single-candidate form exists for direct testability and for
// engine.ts's own error-isolation (one candidate's chain-read failure must
// never abort the rest of the batch).
export async function validateDiscoveredPool(
  deployment: FactoryDeployment,
  candidate: DecodedPairCreated,
  readBlockHash: (chainSlug: string, blockNumber: bigint) => Promise<string | null> = readBlockHashOnChain,
): Promise<ValidationOutcome> {
  const canonicalCheck = await checkBlockHashStillCanonical(candidate.blockNumber, candidate.blockHash, (bn) => readBlockHash(deployment.chainSlug, bn));

  let decoded: DecodedCandidateRead;
  try {
    const calls = buildValidationMulticallCalls([candidate]);
    const results = await withResilientClient(deployment.chainSlug, (client) => client.multicall({ contracts: calls, allowFailure: true }));
    decoded = {
      onchainToken0: results[0]?.status === "success" ? (results[0].result as Address) : null,
      onchainToken1: results[1]?.status === "success" ? (results[1].result as Address) : null,
      onchainFactory: results[2]?.status === "success" ? (results[2].result as Address) : null,
      reservesCallSucceeded: results[3]?.status === "success",
      token0Decimals: results[4]?.status === "success" ? results[4].result : undefined,
      token1Decimals: results[5]?.status === "success" ? results[5].result : undefined,
      token0Symbol: results[6]?.status === "success" && typeof results[6].result === "string" ? results[6].result : null,
      token1Symbol: results[7]?.status === "success" && typeof results[7].result === "string" ? results[7].result : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { accepted: false, reason: `on-chain validation read failed: ${message}` };
  }

  return resolveValidationOutcome(deployment, candidate, decoded, canonicalCheck.status);
}
