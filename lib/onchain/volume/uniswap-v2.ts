import { formatUnits, parseUnits, type Log } from "viem";
import type { DecodedSwapEvent, PricedSwapSide, SwapVolumeResult } from "./types";

// The reusable Uniswap V2 volume/fee adapter - the standard
// IUniswapV2Pair Swap event every genuine V2-style pool emits. Deliberately
// the same human-readable-signature-string convention
// lib/indexing/events.ts's scanBlockRange already requires (parsed via
// viem's own parseAbiItem internally), so this integrates with the
// existing chunked-scan primitive unmodified rather than needing a second
// event-fetching mechanism.
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

// Same generous fixed-point scale as verify-pool.ts's computePoolTvl and
// pricing/uniswap-v2.ts's deriveV2Price - declared locally rather than
// shared, matching this codebase's own established convention of each
// calculation module owning its own copy of this constant (see either of
// those files' own comments for why).
const CALCULATION_SCALE = 30;
const SCALE_FACTOR = BigInt(10) ** BigInt(CALCULATION_SCALE);

function usdValueOf(rawAmount: bigint, decimals: number, priceUsd: string): bigint {
  const amountAtScale = rawAmount * BigInt(10) ** BigInt(CALCULATION_SCALE - decimals);
  const priceAtScale = parseUnits(priceUsd, CALCULATION_SCALE);
  return (amountAtScale * priceAtScale) / SCALE_FACTOR;
}

export interface SwapTokenPrice {
  symbol: string;
  decimals: number;
  priceUsd: string;
  priceSource: string;
}

// Pure - the actual "raw swap amounts + decimals + USD prices -> one
// swap's volume" math, directly unit-testable with plain BigInts, no RPC
// involved (the same "extract the pure calculation" discipline
// computePoolTvl/deriveV2Price already established).
//
// Volume convention: the USD value of the trade's INPUT side(s) - what the
// trader gave up - not "token0 USD + token1 USD" (which would silently
// double the same economic trade, since input and output are two views of
// the identical transfer of value, not two separate trades) and not the
// output side (input and output differ by the swap fee plus any price
// impact, and "what was paid" is the more standard, simpler convention).
// For the overwhelming majority of real swaps exactly one of
// {amount0In, amount1In} is nonzero (confirmed empirically - see
// uniswap-v2.test.ts's real fixtures, 0 of 24 sampled swaps had both
// sides nonzero); the rare dual-input case sums both sides' USD value
// once each, still representing this one swap's total value transferred
// in, never double-counted as two trades.
export function computeSwapVolumeUsd(params: {
  amount0In: bigint;
  amount1In: bigint;
  token0: SwapTokenPrice | null; // null means no price available for token0 at all
  token1: SwapTokenPrice | null;
}): SwapVolumeResult {
  const { amount0In, amount1In, token0, token1 } = params;

  if (amount0In === BigInt(0) && amount1In === BigInt(0)) {
    return { ok: false, error: "swap has no input amount (amount0In and amount1In are both zero)" };
  }

  let totalAtScale = BigInt(0);
  const pricedSides: PricedSwapSide[] = [];

  if (amount0In > BigInt(0)) {
    if (!token0) return { ok: false, error: "missing USD price for token0" };
    if (token0.decimals > CALCULATION_SCALE) return { ok: false, error: `unsupported decimals for ${token0.symbol}: ${token0.decimals}` };
    totalAtScale += usdValueOf(amount0In, token0.decimals, token0.priceUsd);
    pricedSides.push({ symbol: token0.symbol, priceUsd: token0.priceUsd, priceSource: token0.priceSource });
  }
  if (amount1In > BigInt(0)) {
    if (!token1) return { ok: false, error: "missing USD price for token1" };
    if (token1.decimals > CALCULATION_SCALE) return { ok: false, error: `unsupported decimals for ${token1.symbol}: ${token1.decimals}` };
    totalAtScale += usdValueOf(amount1In, token1.decimals, token1.priceUsd);
    pricedSides.push({ symbol: token1.symbol, priceUsd: token1.priceUsd, priceSource: token1.priceSource });
  }

  return { ok: true, volumeUsd: formatUnits(totalAtScale, CALCULATION_SCALE), pricedSides };
}

// Pure - the LP fee one swap generated, in USD: feeBps/10000 of that
// swap's own volumeUsd. The standard Uniswap V2 fee model deducts the fee
// from the input amount BEFORE the constant-product swap math runs (see
// config.ts's own feeVerification comment for how this specific
// deployment's feeBps was confirmed), so the fee scales directly with the
// input side's USD value - exactly the volumeUsd this function is fed.
// Exact BigInt arithmetic throughout, never floating point.
export function computeSwapFeeUsd(volumeUsd: string, feeBps: number): string {
  const volumeAtScale = parseUnits(volumeUsd, CALCULATION_SCALE);
  const feeAtScale = (volumeAtScale * BigInt(feeBps)) / BigInt(10000);
  return formatUnits(feeAtScale, CALCULATION_SCALE);
}
