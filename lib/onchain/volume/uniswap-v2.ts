import type { Log } from "viem";
import type { DecodedSwapEvent } from "./types";

// The reusable Uniswap V2 volume/fee adapter - the standard
// IUniswapV2Pair Swap event every genuine V2-style pool emits. Deliberately
// the same human-readable-signature-string convention
// lib/indexing/events.ts's scanBlockRange already requires (parsed via
// viem's own parseAbiItem internally), so this integrates with the
// existing chunked-scan primitive unmodified rather than needing a second
// event-fetching mechanism.
//
// The actual USD-value/fee math (computeSwapVolumeUsd/computeSwapFeeUsd)
// moved to math.ts in Phase 5.6, once Uniswap V3 needed the identical
// calculation over its own (differently-shaped, but normalizable) event
// data - see math.ts's own module comment. Re-exported here so existing
// V2-specific callers/tests keep importing from this file unchanged.
export { computeSwapFeeUsd, computeSwapVolumeUsd, type SwapTokenPrice } from "./math";

export const SWAP_EVENT_SIGNATURE =
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)";

// Pure - decodes one already-fetched Log into DecodedSwapEvent shape,
// minus blockTimestamp (a Log carries no timestamp of its own - see
// engine.ts's own comment on why that's fetched separately, batched by
// unique block number rather than once per event). Returns null - never
// throws, never fabricates a placeholder amount - for anything malformed:
// a log missing its confirmed-block identity (blockNumber/blockHash/
// transactionHash/logIndex all null on a still-pending log, which
// shouldn't reach here via a real eth_getLogs call but is never assumed
// impossible), or one whose decoded args don't match the expected shape at
// all (a wrong ABI, a non-standard event with a colliding signature hash).
export function decodeSwapLog(log: Log): Omit<DecodedSwapEvent, "blockTimestamp"> | null {
  if (log.blockNumber == null || log.blockHash == null || log.transactionHash == null || log.logIndex == null) {
    return null;
  }

  const args = (log as { args?: Record<string, unknown> }).args;
  if (!args) return null;
  const { sender, amount0In, amount1In, amount0Out, amount1Out, to } = args;
  if (
    typeof sender !== "string" ||
    typeof to !== "string" ||
    typeof amount0In !== "bigint" ||
    typeof amount1In !== "bigint" ||
    typeof amount0Out !== "bigint" ||
    typeof amount1Out !== "bigint"
  ) {
    return null;
  }

  return {
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    sender,
    amount0In,
    amount1In,
    amount0Out,
    amount1Out,
  };
}
