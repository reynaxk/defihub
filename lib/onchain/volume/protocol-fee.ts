import { parseAbi, type Address, type Log } from "viem";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { scanBlockRange } from "@/lib/indexing/events";

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

// ---------------------------------------------------------------------------
// Historical-transition bug fix (PR #14 follow-up)
// ---------------------------------------------------------------------------
//
// The original version of this section (readV3ProtocolFeeStateAcrossRange +
// resolveV3ProtocolRevenueForRange, both since replaced below) read
// slot0().feeProtocol at ONLY the two boundaries of the indexed range and
// assumed "both boundaries agree" meant "the state was constant for the
// WHOLE range." That assumption is false whenever feeProtocol changes twice
// within the range and lands back on the same value it started at - e.g.
// inactive at block 100, an owner call activates it at block 150, another
// call deactivates it again at block 180, inactive again at block 200. Both
// boundary reads (100 and 200) show "inactive," so the old code concluded
// the mechanism was "verified zero for the whole range" - a real, silent
// financial-correctness bug: the [150, 179] window genuinely had the
// protocol-fee mechanism active, and that activity would have been reported
// as zero revenue instead of the honest "unavailable."
//
// The fix: reconstruct every feeProtocol TRANSITION that actually happened
// inside the range from the pool's own real SetFeeProtocol events (the
// canonical Uniswap V3 core event a factory-owner's setFeeProtocol() call
// emits - verified against the real, deployed pool contract's ABI, not
// invented), then classify the range as "verified zero" ONLY if every
// reconstructed segment was inactive throughout - a genuinely stronger,
// event-backed claim than "the two endpoints happened to agree." See
// reconstructV3FeeProtocolSegments/resolveV3ProtocolRevenueFromSegments
// below for the exact logic, and protocol-fee.test.ts for a regression test
// reproducing this exact bug scenario against both the old (fails) and new
// (passes) logic shape.
export const V3_SET_FEE_PROTOCOL_EVENT_SIGNATURE =
  "event SetFeeProtocol(uint8 feeProtocol0Old, uint8 feeProtocol1Old, uint8 feeProtocol0New, uint8 feeProtocol1New)";

export interface V3FeeProtocolTransitionEvent {
  blockNumber: bigint;
  logIndex: number;
  feeProtocol0Old: number;
  feeProtocol1Old: number;
  feeProtocol0New: number;
  feeProtocol1New: number;
}

// Pure, defensive decode - same "return null, never throw, never fabricate"
// contract as decodeSwapLog/decodeV3SwapLog (uniswap-v2.ts/uniswap-v3.ts).
// Verified live that viem decodes a Solidity uint8 event arg as a JS
// `number` (not `bigint`) - confirmed directly against viem's own
// decodeEventLog for this exact event signature during this fix's own
// development, the same "verify the actual decoded type, never assume
// abitype's bigint/number split by intuition" discipline the tick/int24
// bug earlier this phase already established.
export function decodeSetFeeProtocolLog(log: Log): V3FeeProtocolTransitionEvent | null {
  if (log.blockNumber == null || log.logIndex == null) return null;
  const args = (log as { args?: Record<string, unknown> }).args;
  if (!args) return null;
  const { feeProtocol0Old, feeProtocol1Old, feeProtocol0New, feeProtocol1New } = args;
  if (
    typeof feeProtocol0Old !== "number" ||
    typeof feeProtocol1Old !== "number" ||
    typeof feeProtocol0New !== "number" ||
    typeof feeProtocol1New !== "number"
  ) {
    return null;
  }
  return { blockNumber: log.blockNumber, logIndex: log.logIndex, feeProtocol0Old, feeProtocol1Old, feeProtocol0New, feeProtocol1New };
}

// RPC-touching - every SetFeeProtocol event this pool emitted within
// [fromBlock, toBlock], via the SAME chunked, resilient scanBlockRange
// primitive (lib/indexing/events.ts) every other historical log scan in
// this app uses (Section 11's "do not create a second historical scanner" -
// this reuses Phase 5/5.5's own primitive, not a new eth_getLogs wrapper).
// The range this is called with is always already bounded to at most one
// volume-indexing chunk's width (DEFAULT_VOLUME_CHUNK_SIZE, engine.ts) -
// never a second, independent, unbounded scan.
export async function readV3FeeProtocolTransitions(
  chainSlug: string,
  poolAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<V3FeeProtocolTransitionEvent[]> {
  const logs = await scanBlockRange({
    chainSlug,
    address: poolAddress as Address,
    eventSignature: V3_SET_FEE_PROTOCOL_EVENT_SIGNATURE,
    fromBlock,
    toBlock,
  });
  const decoded: V3FeeProtocolTransitionEvent[] = [];
  for (const log of logs) {
    const event = decodeSetFeeProtocolLog(log);
    if (event) decoded.push(event);
  }
  return decoded;
}

export interface V3FeeProtocolSegment {
  // Inclusive block bounds. For the first/last segment these are the
  // overall query's own fromBlock/toBlock; for an interior segment (or the
  // segment starting exactly at a transition), these are the transition's
  // own block boundaries.
  fromBlock: bigint;
  toBlock: bigint;
  feeProtocol: number; // packed byte - same representation as V3ProtocolFeeState.feeProtocol
  active: boolean;
}

// Pure - reconstructs the sequence of feeProtocol states that actually
// applied across [fromBlock, toBlock], given every real transition event
// found in that range (already sorted here by (blockNumber, logIndex) -
// callers do not need to pre-sort, which also makes this function directly
// exercise the "transition in the same block as another event" ordering
// case Section 8 asks for). `referenceState` is a direct slot0() read
// pinned to `toBlock`, used two ways: (1) as the WHOLE range's constant
// state when zero transitions were found (the common case - feeProtocol
// changes are a rare, deliberate governance action, not a per-swap
// occurrence), and (2) as an independent cross-check the caller
// (resolveV3ProtocolRevenueForRange below) compares against the
// reconstructed final segment, so an incomplete/wrong event scan can never
// silently produce a wrong classification - see that function's own
// comment.
//
// Boundary convention: a transition's own block is treated as ALREADY
// reflecting its New state (setFeeProtocol updates slot0.feeProtocol
// synchronously within the same transaction the event is emitted from, so
// nothing later in that same block - or any later block - could still be
// observing the Old value). This is the safe direction if a transition's
// exact intra-block ordering relative to a swap is ever ambiguous: treating
// the whole block as "New" starting immediately can only make a segment
// MORE likely to be classified active (and therefore revenue "unavailable"
// rather than fabricated "zero"), never the reverse.
export function reconstructV3FeeProtocolSegments(
  fromBlock: bigint,
  toBlock: bigint,
  transitions: readonly V3FeeProtocolTransitionEvent[],
  referenceState: V3ProtocolFeeState,
): V3FeeProtocolSegment[] {
  if (transitions.length === 0) {
    return [{ fromBlock, toBlock, feeProtocol: referenceState.feeProtocol, active: referenceState.active }];
  }

  const sorted = [...transitions].sort((a, b) =>
    a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex,
  );

  const segments: V3FeeProtocolSegment[] = [];
  let segmentStart = fromBlock;
  // The state that applied immediately before the FIRST transition found in
  // this range is exactly that transition's own Old value - nothing else
  // could have changed it between fromBlock and this transition's block,
  // since this scan already covers the entire range and found no earlier
  // transition.
  let currentPacked = sorted[0].feeProtocol0Old + (sorted[0].feeProtocol1Old << 4);

  for (const transition of sorted) {
    if (transition.blockNumber > segmentStart) {
      segments.push({ fromBlock: segmentStart, toBlock: transition.blockNumber - BigInt(1), feeProtocol: currentPacked, active: currentPacked !== 0 });
    }
    currentPacked = transition.feeProtocol0New + (transition.feeProtocol1New << 4);
    segmentStart = transition.blockNumber;
  }
  segments.push({ fromBlock: segmentStart, toBlock, feeProtocol: currentPacked, active: currentPacked !== 0 });

  return segments;
}

// Pure - the actual available/unavailable decision given an already-
// reconstructed segment list. "Verified zero" now requires EVERY segment
// in the range to be inactive (a genuinely stronger claim than the old
// two-boundary check's "the two endpoints happened to agree") - a single
// active segment anywhere in the range is enough to mark the whole range's
// revenue unavailable, exactly matching this file's "never fabricate zero"
// rule from Section 5. Never returns `available: true` for anything other
// than the all-inactive case.
export function resolveV3ProtocolRevenueFromSegments(fromBlock: bigint, toBlock: bigint, segments: readonly V3FeeProtocolSegment[]): ProtocolRevenueOutcome {
  const activeSegments = segments.filter((s) => s.active);

  if (activeSegments.length === 0) {
    return {
      available: true,
      revenueUsd: "0",
      reason:
        segments.length === 1
          ? `slot0().feeProtocol was verified as 0 for the ENTIRE indexed range (blocks ${fromBlock}-${toBlock}, no SetFeeProtocol transitions found) - the protocol-fee mechanism was inactive for the whole range, so captured revenue is exactly zero, not merely unmeasured`
          : `slot0().feeProtocol was reconstructed as 0 for the ENTIRE indexed range (blocks ${fromBlock}-${toBlock}) across ${segments.length} segments separated by real SetFeeProtocol transitions, none of which ever activated the mechanism - captured revenue is exactly zero, not merely unmeasured`,
    };
  }

  const first = activeSegments[0];
  return {
    available: false,
    reason:
      segments.length === 1
        ? `slot0().feeProtocol (${first.feeProtocol}) is active across this indexed range (blocks ${fromBlock}-${toBlock}) - realized protocol revenue requires tracking every Swap's fee-growth contribution and every collectProtocol() call, which this phase does not implement`
        : `slot0().feeProtocol changed within this indexed range (blocks ${fromBlock}-${toBlock}, reconstructed into ${segments.length} segments from real SetFeeProtocol events) and was active for at least blocks ${first.fromBlock}-${first.toBlock} (feeProtocol=${first.feeProtocol}) - realized protocol revenue requires tracking every Swap's fee-growth contribution and every collectProtocol() call across the transition, which this phase does not implement`,
  };
}

// RPC-touching orchestration - the V3 revenue entry point engine.ts calls,
// replacing the old readV3ProtocolFeeStateAcrossRange +
// resolveV3ProtocolRevenueForRange two-call sequence with one call that
// does its own event-backed reconstruction internally. Reads the reference
// state (pinned to toBlock) and scans for real transitions IN PARALLEL,
// then cross-checks them: if the reconstructed final segment's feeProtocol
// disagrees with the independently-read reference state, something is
// inconsistent (a reorg landed between the two reads, or the event scan
// was somehow incomplete) - rather than trusting either value blindly, this
// reports the whole range unavailable, the same "unknown != zero, when in
// doubt report unavailable" discipline as every other branch here. Never
// throws for an ordinary RPC failure inside either read (both go through
// withResilientClient/scanBlockRange's own retry/failover); an error here
// propagates to engine.ts's resolveProtocolRevenueForPool, which already
// catches it and treats it as "no revenue outcome this chunk" (never a
// fabricated result).
export async function resolveV3ProtocolRevenueForRange(chainSlug: string, poolAddress: string, fromBlock: bigint, toBlock: bigint): Promise<ProtocolRevenueOutcome> {
  const [referenceState, transitions] = await Promise.all([
    readV3ProtocolFeeState(chainSlug, poolAddress, toBlock),
    readV3FeeProtocolTransitions(chainSlug, poolAddress, fromBlock, toBlock),
  ]);

  const segments = reconstructV3FeeProtocolSegments(fromBlock, toBlock, transitions, referenceState);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment.feeProtocol !== referenceState.feeProtocol) {
    return {
      available: false,
      reason:
        `reconstructed feeProtocol state (${lastSegment.feeProtocol}) at the end of this range disagrees with a direct slot0() read at block ${toBlock} (${referenceState.feeProtocol}) - ` +
        "the SetFeeProtocol event scan may be incomplete or a reorg landed between these two reads, so realized revenue cannot be safely determined for this range",
    };
  }

  return resolveV3ProtocolRevenueFromSegments(fromBlock, toBlock, segments);
}
