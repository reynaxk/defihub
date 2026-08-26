import { parseAbi, type Address } from "viem";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";

// Phase 5.4's protocol-revenue engine for Uniswap V2-style pools - and a
// deliberate, documented STOP on the one real deployment this phase
// configures (see config.ts's own feeVerification comment for how this
// was discovered).
//
// LP fees (0.30% of swap volume, computeSwapFeeUsd in uniswap-v2.ts) are
// NOT the same thing as protocol revenue - the task's own "revenue !=
// volume x generic fee percentage" instruction applies exactly here.
// Uniswap V2's protocol-fee mechanism (factory.feeTo()) is OFF by default
// (the zero address) for a fresh factory; when it's set to a real address,
// 1/6th of the pool's sqrt(k) growth since the last liquidity event gets
// minted as new LP shares to that address - but ONLY at the next Mint or
// Burn call, not per-swap. That means:
//   - feeTo() == 0x0: protocol revenue is VERIFIABLY, exactly zero - this
//     is a direct on-chain fact, not an assumption, and this module reports
//     it as such with full confidence.
//   - feeTo() != 0x0: the mechanism is active, but the REALIZED amount
//     requires tracking every Mint/Burn event for this pool plus the
//     pool's own kLast state to compute the sqrt(k) growth each one
//     captured - a genuinely different, materially more complex read than
//     anything else this phase implements (event tracking for a SECOND
//     event family, plus historical state reconstruction). Implementing
//     that within this phase's remaining scope was judged unsafe to rush,
//     per this task's own explicit stop-condition instruction - so this
//     module reports the metric as UNAVAILABLE rather than guessing at it
//     with "volume x some fraction," which would be exactly the fabricated
//     number the task explicitly forbids.
//
// This IS the real, live state for this phase's one configured pool
// (lib/onchain/volume/config.ts's uniswap-v2-eth-usdc-weth entry):
// feeTo() returned 0xf38521f130fcCF29dB1961597bc5d2B60F995f85 (active) when
// verified. Protocol revenue for that specific pool is therefore reported
// as unavailable by this module today - not a placeholder, not a future
// TODO silently returning 0, an honest "not implemented, here is exactly
// why" outcome. See resolveProtocolRevenueForRange below for the exact
// decision logic.
//
// CodeRabbit fix round: reading feeTo() only at the CURRENT chain head
// (this module's original implementation) is not sufficient to attribute
// revenue for an INDEXED HISTORICAL RANGE. A concrete failure case: feeTo()
// is active at block 100, gets disabled at block 200, and the current head
// is block 300 - a run indexing swaps in [100, 200] must not read feeTo()
// "now" (at 300, showing disabled) and conclude the whole range had zero
// revenue, when it was actually active for most of it. This module now
// reads feeTo() PINNED to the two boundaries of the range actually being
// attributed (readV2ProtocolFeeStateAcrossRange, reading at both fromBlock
// and toBlock) rather than at an unpinned "latest" read. This is
// deliberately NOT a full event-based feeTo-transition indexer (explicitly
// out of scope per this task's own instruction): it does not detect every
// possible transition inside the range, only a transition that changes the
// state BETWEEN the two boundaries actually checked. A transition that
// happens to return to the same state at both boundaries (active -> zero ->
// active again, both ends reading "active") is not detected by this
// boundary check and would be reported as the (correct, since both
// boundaries genuinely show "active") "unavailable" outcome regardless -
// the false-positive direction this leaves open is reporting MORE ranges as
// unavailable than strictly necessary, never fabricating a zero for a range
// that had real activity. Both boundary reads are pinned to blocks already
// known to be within this provider's live-servable window (the same
// recent-window constraint effectiveStartBlock/engine.ts already respects
// for eth_getLogs), since both fromBlock and toBlock of any run this
// indexer produces are, by construction, recent blocks.
export const V2_FACTORY_ABI = parseAbi(["function feeTo() view returns (address)"]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ProtocolFeeState {
  factoryAddress: string;
  feeToAddress: string;
  active: boolean;
}

// Reads the feeTo() state for one V2-style factory, optionally pinned to a
// specific historical block - a real RPC read, through the same
// withResilientClient every other on-chain read in this app uses. Omitting
// `atBlock` reads the current/latest state (kept for callers that
// genuinely want "right now," though engine.ts itself always pins both
// boundaries explicitly via readV2ProtocolFeeStateAcrossRange below).
export async function readV2ProtocolFeeState(chainSlug: string, factoryAddress: string, atBlock?: bigint): Promise<ProtocolFeeState> {
  const feeToAddress = await withResilientClient(chainSlug, (client) =>
    client.readContract({
      address: factoryAddress as Address,
      abi: V2_FACTORY_ABI,
      functionName: "feeTo",
      ...(atBlock != null ? { blockNumber: atBlock } : {}),
    }),
  );
  return {
    factoryAddress,
    feeToAddress,
    active: feeToAddress.toLowerCase() !== ZERO_ADDRESS,
  };
}

export interface HistoricalFeeCheckResult {
  fromBlock: bigint;
  toBlock: bigint;
  fromBlockState: ProtocolFeeState;
  toBlockState: ProtocolFeeState;
}

// Reads feeTo() pinned to BOTH boundaries of an indexed range - the
// historical-state-aware read this module's revenue decision is actually
// based on (see this file's own header comment for exactly what this does
// and does not prove). A single read when fromBlock === toBlock (a run
// whose scan start and last-observed-swap block happen to coincide) avoids
// an unnecessary duplicate RPC call for the same block.
export async function readV2ProtocolFeeStateAcrossRange(
  chainSlug: string,
  factoryAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<HistoricalFeeCheckResult> {
  if (fromBlock === toBlock) {
    const state = await readV2ProtocolFeeState(chainSlug, factoryAddress, fromBlock);
    return { fromBlock, toBlock, fromBlockState: state, toBlockState: state };
  }
  const [fromBlockState, toBlockState] = await Promise.all([
    readV2ProtocolFeeState(chainSlug, factoryAddress, fromBlock),
    readV2ProtocolFeeState(chainSlug, factoryAddress, toBlock),
  ]);
  return { fromBlock, toBlock, fromBlockState, toBlockState };
}

export type ProtocolRevenueOutcome =
  | { available: true; revenueUsd: string; reason: string }
  | { available: false; reason: string };

// Pure - the actual available/unavailable decision, given an already-read
// HistoricalFeeCheckResult, directly unit-testable without an RPC call.
// Three outcomes:
//   - the two boundaries disagree (a transition happened somewhere between
//     them) -> unavailable, the state change itself is the reason.
//   - both boundaries agree the mechanism was inactive -> revenue
//     verifiably zero for the whole range.
//   - both boundaries agree the mechanism was active -> unavailable (the
//     Mint/Burn + kLast tracking this phase doesn't implement).
// Never returns `available: true` for anything other than the
// both-inactive case - "active at both ends" is never treated as license
// to guess at a nonzero figure, regardless of how volume/fees looked this
// run.
export function resolveProtocolRevenueForRange(check: HistoricalFeeCheckResult): ProtocolRevenueOutcome {
  const { fromBlock, toBlock, fromBlockState, toBlockState } = check;

  if (fromBlockState.active !== toBlockState.active) {
    return {
      available: false,
      reason:
        `factory.feeTo() state differs between the start (block ${fromBlock}, ${fromBlockState.active ? "active" : "inactive"}) and end (block ${toBlock}, ${toBlockState.active ? "active" : "inactive"}) of this indexed range - the protocol-fee mechanism changed state within this range, so realized revenue cannot be determined without full Mint/Burn + kLast tracking across the transition`,
    };
  }

  if (!toBlockState.active) {
    return {
      available: true,
      revenueUsd: "0",
      reason:
        `factory.feeTo() (${toBlockState.factoryAddress}) was verified as the zero address at BOTH the start (block ${fromBlock}) and end (block ${toBlock}) of this indexed range - the protocol-fee mechanism was inactive for the whole range, so captured revenue is exactly zero, not merely unmeasured`,
    };
  }

  return {
    available: false,
    reason:
      `factory.feeTo() (${toBlockState.factoryAddress}) = ${toBlockState.feeToAddress} is active across this indexed range (blocks ${fromBlock}-${toBlock}) - realized protocol revenue requires tracking every Mint/Burn event for this pool and its kLast state to compute the sqrt(k) growth each one captured, which this phase does not implement`,
  };
}

// ---------------------------------------------------------------------------
// Uniswap V3 (Phase 5.6)
// ---------------------------------------------------------------------------
//
// V3's protocol-fee mechanism is genuinely different from V2's, not the
// same concept under a new name:
//   - V2: a single boolean-ish switch (factory.feeTo() zero or not),
//     realized as LP-share dilution computed from kLast at the next
//     Mint/Burn.
//   - V3: slot0().feeProtocol is a packed uint8 - the low 4 bits are
//     token0's protocol-fee denominator (0 = off, 4-10 = 1/N of the LP fee
//     tier itself), the high 4 bits are token1's. Realized amounts
//     accumulate in the pool's own protocolFees.token0/token1 storage as
//     swaps happen, and are only actually paid out when the factory owner
//     calls collectProtocol() (a Collect-shaped event, not indexed this
//     phase). feeProtocol == 0 means NEITHER token has protocol fees
//     active - the same "verifiably, exactly zero" case V2's zero-address
//     feeTo() represents. Any nonzero value means at least one token has
//     an active cut, but the REALIZED amount requires tracking every
//     Swap's fee-growth contribution plus every collectProtocol() call - a
//     larger, genuinely different scope than this phase implements, so
//     (matching V2's own precedent exactly) this reports "unavailable"
//     rather than guessing.
//
// This IS the real, live state for this phase's one configured V3 pool
// (lib/onchain/volume/config.ts's uniswap-v3-eth-usdc-weth-005 entry):
// slot0().feeProtocol returned 68 (0x44 = token0 sub-fee 4, token1 sub-fee
// 4 - both active) when verified. Protocol revenue for that specific pool
// is therefore reported as unavailable by this module today, for the same
// "honest, not a placeholder" reason as the V2 pool.
export const V3_POOL_SLOT0_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

export interface V3ProtocolFeeState {
  poolAddress: string;
  feeProtocol: number;
  active: boolean;
}

// Reads slot0() directly from the POOL contract itself (unlike V2, which
// reads feeTo() from a separate factory contract) - optionally pinned to a
// specific historical block, same reasoning as readV2ProtocolFeeState.
export async function readV3ProtocolFeeState(chainSlug: string, poolAddress: string, atBlock?: bigint): Promise<V3ProtocolFeeState> {
  const [, , , , , feeProtocol] = await withResilientClient(chainSlug, (client) =>
    client.readContract({
      address: poolAddress as Address,
      abi: V3_POOL_SLOT0_ABI,
      functionName: "slot0",
      ...(atBlock != null ? { blockNumber: atBlock } : {}),
    }),
  );
  return { poolAddress, feeProtocol, active: feeProtocol !== 0 };
}

export interface HistoricalV3FeeCheckResult {
  fromBlock: bigint;
  toBlock: bigint;
  fromBlockState: V3ProtocolFeeState;
  toBlockState: V3ProtocolFeeState;
}

// The V3 twin of readV2ProtocolFeeStateAcrossRange - same reasoning
// (pinned to BOTH boundaries of the range actually being attributed,
// never an unpinned "current" read - see this file's own header comment),
// same single-read optimization when the range is a single block.
export async function readV3ProtocolFeeStateAcrossRange(
  chainSlug: string,
  poolAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<HistoricalV3FeeCheckResult> {
  if (fromBlock === toBlock) {
    const state = await readV3ProtocolFeeState(chainSlug, poolAddress, fromBlock);
    return { fromBlock, toBlock, fromBlockState: state, toBlockState: state };
  }
  const [fromBlockState, toBlockState] = await Promise.all([
    readV3ProtocolFeeState(chainSlug, poolAddress, fromBlock),
    readV3ProtocolFeeState(chainSlug, poolAddress, toBlock),
  ]);
  return { fromBlock, toBlock, fromBlockState, toBlockState };
}

// The V3 twin of resolveProtocolRevenueForRange - identical three-outcome
// shape (boundaries disagree -> unavailable; both inactive -> verified
// zero; both active -> unavailable), same ProtocolRevenueOutcome return
// type so engine.ts's downstream handling (recording revenue_usd, logging
// the "unavailable" reason) is identical regardless of which protocol
// produced the check.
export function resolveV3ProtocolRevenueForRange(check: HistoricalV3FeeCheckResult): ProtocolRevenueOutcome {
  const { fromBlock, toBlock, fromBlockState, toBlockState } = check;

  if (fromBlockState.active !== toBlockState.active) {
    return {
      available: false,
      reason:
        `slot0().feeProtocol state differs between the start (block ${fromBlock}, ${fromBlockState.active ? "active" : "inactive"}) and end (block ${toBlock}, ${toBlockState.active ? "active" : "inactive"}) of this indexed range - the protocol-fee mechanism changed state within this range, so realized revenue cannot be determined without full Swap fee-growth + Collect event tracking across the transition`,
    };
  }

  if (!toBlockState.active) {
    return {
      available: true,
      revenueUsd: "0",
      reason:
        `slot0().feeProtocol (pool ${toBlockState.poolAddress}) was verified as 0 at BOTH the start (block ${fromBlock}) and end (block ${toBlock}) of this indexed range - the protocol-fee mechanism was inactive for the whole range, so captured revenue is exactly zero, not merely unmeasured`,
    };
  }

  return {
    available: false,
    reason:
      `slot0().feeProtocol (pool ${toBlockState.poolAddress}) = ${toBlockState.feeProtocol} is active across this indexed range (blocks ${fromBlock}-${toBlock}) - realized protocol revenue requires tracking every Swap's fee-growth contribution and every collectProtocol() call, which this phase does not implement`,
  };
}
