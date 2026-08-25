import { formatUnits, parseAbi, parseUnits } from "viem";

// The reusable Uniswap V2 (constant-product AMM) price adapter. Deliberately
// generic to "any V2-style pool" (Uniswap V2 itself, and any fork that keeps
// the same getReserves()/token0()/token1() interface and constant-product
// invariant - PancakeSwap V2, SushiSwap V2, Aerodrome's volatile pools, etc.)
// rather than hardcoded to one deployment, matching this app's existing
// "one adapter, config-driven" philosophy (see verify-vault.ts's own module
// comment for the ERC-4626 precedent this follows).
//
// A V2 pool's own reserve ratio IS its spot price: reserve1/reserve0 tokens
// of asset1 per asset0, by the constant-product invariant (x*y=k) - no
// oracle, no external price feed, no off-chain computation. Converting that
// ratio to a USD price needs exactly one more input: a trusted USD price for
// whichever side of the pool is being used as the reference (see
// lib/onchain/pricing/config.ts's REFERENCE_ASSETS and reference-graph.ts for
// how that reference price itself gets resolved, dependency-ordered, without
// ever assuming a stablecoin is exactly $1).
export const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// Same generous fixed-point scale as verify-pool.ts's computePoolTvl, and
// for the identical reason: large enough that a low-price/high-decimals
// token doesn't underflow to zero, with BigInt itself having no practical
// size limit to worry about. Declared locally rather than imported from
// verify-pool.ts - each verification/pricing module in this codebase
// already declares its own copy of this constant (verify-pool.ts,
// verify-vault.ts), not a shared one, so a future change to one calculation
// kind's precision can't silently affect an unrelated one.
const CALCULATION_SCALE = 30;
const SCALE_FACTOR = BigInt(10) ** BigInt(CALCULATION_SCALE);

const EXACT_NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

export interface DeriveV2PriceParams {
  // The reserve/decimals of the token being priced, and of the token it's
  // paired against in this pool - already resolved by the caller to "which
  // side is which" (see reference-graph.ts/engine.ts, which read token0()/
  // token1() and match them against the configured pair), not decided here.
  pricedReserve: bigint;
  pricedDecimals: number;
  pairedReserve: bigint;
  pairedDecimals: number;
  // An exact decimal string, never a `number` - see verify-pool.ts's own
  // priceToExactDecimalString for why: the caller (engine.ts) has already
  // resolved this from either the hand-declared anchor or a previously
  // resolved reference price (reference-graph.ts), and this function must
  // never be the place a price re-enters floating point.
  pairedPriceUsd: string;
  // A pool below this depth is rejected outright (see minLiquidityUsd's own
  // config comment in config.ts for why a threshold is needed at all) -
  // enforced here, not left to the aggregation layer, so a single
  // microscopic pool can never even produce a CandidatePriceSource to begin
  // with.
  minLiquidityUsd: string;
}

export type DeriveV2PriceResult =
  | { ok: true; priceUsd: string; liquidityUsd: string }
  | { ok: false; error: string };

// Pure - no RPC, no multicall, directly unit-testable with plain BigInts.
// Every step is exact BigInt/fixed-point arithmetic, matching
// computePoolTvl's own contract: exact result or an explicit failure, never
// a silently wrong number from floating point or a fabricated zero.
export function deriveV2Price(params: DeriveV2PriceParams): DeriveV2PriceResult {
  const { pricedReserve, pricedDecimals, pairedReserve, pairedDecimals, pairedPriceUsd, minLiquidityUsd } = params;

  if (pricedDecimals > CALCULATION_SCALE || pairedDecimals > CALCULATION_SCALE) {
    return { ok: false, error: `unsupported decimals exceeding this calculation's ${CALCULATION_SCALE}-decimal scale` };
  }
  if (!EXACT_NON_NEGATIVE_DECIMAL.test(pairedPriceUsd)) {
    return { ok: false, error: `invalid paired token USD price: ${pairedPriceUsd}` };
  }
  // A zero reserve means an empty (or not-yet-seeded) pool - there is no
  // real price to derive, and dividing by it would be undefined, never
  // silently treated as an infinite or zero price.
  if (pricedReserve <= BigInt(0) || pairedReserve <= BigInt(0)) {
    return { ok: false, error: "pool has zero (or negative) reserves - no price to derive" };
  }

  // Both reserves rescaled to the same CALCULATION_SCALE fixed-point
  // representation - pure integer rescaling, no remainder discarded (the
  // decimals check above guarantees the exponent is never negative).
  const pricedAtScale = pricedReserve * BigInt(10) ** BigInt(CALCULATION_SCALE - pricedDecimals);
  const pairedAtScale = pairedReserve * BigInt(10) ** BigInt(CALCULATION_SCALE - pairedDecimals);

  // parseUnits parses the exact decimal string using exact integer
  // arithmetic (confirmed in verify-pool.ts's own identical use) - never a
  // floating-point multiplication.
  const pairedPriceAtScale = parseUnits(pairedPriceUsd, CALCULATION_SCALE);

  // The paired side's total USD value in this pool, at CALCULATION_SCALE:
  // (pairedReserve in real units) * (paired USD price). Both operands are
  // exact integers at CALCULATION_SCALE; their product lands at
  // 2xCALCULATION_SCALE, so dividing back down by SCALE_FACTOR undoes an
  // exact prior multiplication rather than discarding meaningful precision -
  // identical shape to computePoolTvl's own usdValueAtScale step.
  const pairedValueUsdAtScale = (pairedAtScale * pairedPriceAtScale) / SCALE_FACTOR;

  // A standard, well-known approximation for a constant-product pool's total
  // USD depth: by construction each side holds equal USD value at the
  // current price, so doubling one side's USD value approximates the whole
  // pool - the same "2x one side" convention GeckoTerminal/DeFiLlama's own
  // public liquidity figures use for V2-style pools, not a bespoke formula.
  const liquidityUsdAtScale = pairedValueUsdAtScale * BigInt(2);
  const liquidityUsd = formatUnits(liquidityUsdAtScale, CALCULATION_SCALE);

  if (parseUnits(liquidityUsd, CALCULATION_SCALE) < parseUnits(minLiquidityUsd, CALCULATION_SCALE)) {
    return { ok: false, error: `pool liquidity $${liquidityUsd} is below the $${minLiquidityUsd} minimum - too shallow to trust` };
  }

  // Price per priced-token = (paired side's total USD value) / (priced
  // token's own reserve, in real units) - rescaled back up by SCALE_FACTOR
  // first so the division itself doesn't collapse to zero for a
  // low-price/high-supply token.
  const priceAtScale = (pairedValueUsdAtScale * SCALE_FACTOR) / pricedAtScale;
  const priceUsd = formatUnits(priceAtScale, CALCULATION_SCALE);

  return { ok: true, priceUsd, liquidityUsd };
}
