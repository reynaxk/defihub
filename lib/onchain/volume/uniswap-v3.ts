import type { Log } from "viem";
import type { DecodedSwapEvent } from "./types";

// Phase 5.6's Uniswap V3 volume adapter. Deliberately NOT a copy-paste of
// uniswap-v2.ts with renamed identifiers - V3's Swap event has a genuinely
// different shape and sign convention (see decodeV3SwapLog's own comment),
// and this file's whole job is to correctly normalize that difference away
// BEFORE handing anything to the shared, protocol-neutral math in math.ts.
//
// Reuses the SAME swap_events table as V2 (lib/database/schema.ts), not a
// dedicated v3_swap_events one - deliberately, per this phase's own
// "minimize schema changes" instruction. The event IDENTITY (poolId,
// transactionHash, logIndex, blockHash - see schema.ts's own comment on
// swap_events_pool_tx_log_hash_unique) and every reorg-safety/idempotency
// mechanism (lib/onchain/volume/reorg.ts, record-swap-events.ts) are
// already fully generic over "one row per decoded swap, whatever protocol
// decoded it" - sourceKind ("uniswap-v3" here, set by the caller in
// engine.ts) is the only per-row marker distinguishing which adapter
// produced it, and nothing in the reorg/idempotency path needs to know or
// care which one that was. Three new NULLABLE columns
// (sqrt_price_x96/liquidity/tick) hold V3-only state that V2 rows simply
// never populate.

// The canonical IUniswapV3Pool Swap event - see
// https://github.com/Uniswap/v3-core's own IUniswapV3PoolEvents.sol for
// the authoritative definition this signature matches exactly.
export const V3_SWAP_EVENT_SIGNATURE =
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";

// int24's real range - Solidity's smallest signed tick-index type.
const MAX_TICK = 8388607;
const MIN_TICK = -8388608;

// Pure - decodes one already-fetched V3 Swap log into the SAME
// DecodedSwapEvent shape uniswap-v2.ts's decodeSwapLog produces (minus
// blockTimestamp, fetched separately - see engine.ts), so every downstream
// consumer (math.ts's computeSwapVolumeUsd/computeSwapFeeUsd,
// record-swap-events.ts, the reorg-recheck path) works identically
// regardless of which protocol produced the row.
//
// V3's Swap event carries a single SIGNED (amount0, amount1) pair, not
// V2's separate unsigned In/Out fields: a POSITIVE amount means that token
// flowed INTO the pool (what the trader paid - the input); a NEGATIVE
// amount means it flowed OUT (what the trader received - the output). A
// genuine V3 swap's constant-sum-invariant guarantees exactly one of the
// two is positive and the other negative (the pool's own accounting
// requires one token's balance to rise and the other's to fall - never
// both the same sign for a real swap). Splitting each signed amount into
// its positive ("In") and negative-negated ("Out") parts is therefore a
// LOSSLESS, exact re-expression of the identical economic fact V2's event
// already carries directly - not an approximation, and not "pretending V3
// is V2." This is what lets math.ts's computeSwapVolumeUsd (the "USD value
// of the input side(s)" convention already established for V2) apply
// completely unchanged to V3 swaps too.
export function decodeV3SwapLog(log: Log): Omit<DecodedSwapEvent, "blockTimestamp"> | null {
  if (log.blockNumber == null || log.blockHash == null || log.transactionHash == null || log.logIndex == null) {
    return null;
  }

  const args = (log as { args?: Record<string, unknown> }).args;
  if (!args) return null;
  const { sender, amount0, amount1, sqrtPriceX96, liquidity, tick } = args;
  if (
    typeof sender !== "string" ||
    typeof amount0 !== "bigint" ||
    typeof amount1 !== "bigint" ||
    typeof sqrtPriceX96 !== "bigint" ||
    typeof liquidity !== "bigint" ||
    // Verified live against real decoded Swap logs: viem/abitype decodes
    // int24 (unlike the wider int256/uint160/uint128 fields above) as a
    // plain JS `number`, not `bigint` - genuinely different from every
    // other field in this event, not an inconsistency in this file. tick
    // is small and bounded (int24: -8,388,608 to 8,388,607) so a JS number
    // represents it exactly with no precision loss - categorically
    // different from the "unsafe Number() on a uint256 token amount" this
    // app's own conventions forbid elsewhere, which is why this is a type
    // check against `number`, not a Number() conversion of a bigint.
    typeof tick !== "number" ||
    !Number.isInteger(tick)
  ) {
    return null;
  }

  // Still never assumed safe just because the type matched: a decoded
  // value outside int24's real range would mean a malformed/non-standard
  // event (a wrong ABI, a colliding event signature hash), treated the
  // same as any other decode failure - never silently truncated or
  // wrapped.
  if (tick > MAX_TICK || tick < MIN_TICK) return null;

  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    sender,
    amount0In: amount0 > BigInt(0) ? amount0 : BigInt(0),
    amount0Out: amount0 < BigInt(0) ? -amount0 : BigInt(0),
    amount1In: amount1 > BigInt(0) ? amount1 : BigInt(0),
    amount1Out: amount1 < BigInt(0) ? -amount1 : BigInt(0),
    sqrtPriceX96,
    liquidity,
    tick,
  };
}
