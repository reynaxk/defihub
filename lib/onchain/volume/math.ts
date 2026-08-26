import { formatUnits, parseUnits } from "viem";
import type { PricedSwapSide, SwapVolumeResult } from "./types";

// Phase 5.6: extracted from uniswap-v2.ts, which owned this alone until a
// second protocol (Uniswap V3) needed the identical math. This is
// genuinely protocol-agnostic, not "V2 logic renamed" - both V2's
// {amount0In, amount1In} and V3's decoded {amount0In, amount1In} (see
// uniswap-v3.ts's own decodeV3SwapLog for how V3's signed amount0/amount1
// pair gets normalized into this same shape) describe the identical
// underlying economic fact: "which token, and how much of it, did the
// trader hand over." Once normalized to that common shape, the USD-value
// and fee math is identical regardless of which AMM produced the event -
// that's what makes sharing this file correct rather than a shortcut.
// V3-specific concerns (decoding the signed on-chain event, its
// sqrtPriceX96/liquidity/tick fields, its own fee-tier semantics) all stay
// in uniswap-v3.ts; this file only ever sees the already-normalized,
// protocol-neutral shape.

// Same generous fixed-point scale as verify-pool.ts's computePoolTvl and
// pricing/uniswap-v2.ts's deriveV2Price - declared locally rather than
// shared, matching this codebase's own established convention of each
// calculation module owning its own copy of this constant (see either of
// those files' own comments for why).
export const CALCULATION_SCALE = 30;
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
// {amount0In, amount1In} is nonzero (confirmed empirically for V2 - see
// uniswap-v2.test.ts's real fixtures, 0 of 24 sampled swaps had both sides
// nonzero; structurally guaranteed for V3 - see uniswap-v3.ts's own
// decodeV3SwapLog comment, a genuine V3 swap's signed amount0/amount1 pair
// can never both be positive); the rare/impossible dual-input case still
// sums both sides' USD value once each, representing this one swap's total
// value transferred in, never double-counted as two trades.
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
// swap's own volumeUsd. `feeBps` is always expressed in this shared
// bps-out-of-10000 unit regardless of source protocol - V2's fixed 0.30%
// is 30 here; V3's per-pool fee tier (natively hundredths-of-a-bip,
// denominator 1,000,000) is converted to this same unit at config time
// (divide by 100 - see config.ts's own comment on VolumeSourcePool.feeBps
// for the worked conversion and why it's always exact for the standard V3
// tiers) rather than this function accepting two different denominators
// depending on caller. Exact BigInt arithmetic throughout, never floating
// point.
export function computeSwapFeeUsd(volumeUsd: string, feeBps: number): string {
  const volumeAtScale = parseUnits(volumeUsd, CALCULATION_SCALE);
  const feeAtScale = (volumeAtScale * BigInt(feeBps)) / BigInt(10000);
  return formatUnits(feeAtScale, CALCULATION_SCALE);
}
