// Phase 5.4: shared types for the independent on-chain volume/fee engine.
// Structurally parallel to lib/onchain/pricing/types.ts (the same
// "adapter kind, dependency-free leaf module" discipline), but a distinct
// concept: pricing/types.ts's PriceSourceKind names a REFERENCE-PRICE
// source (a pool used to derive a token's USD price); this names a VOLUME
// source (a pool whose own trades are being measured). A pool can appear
// in both roles, but the two config lists (REFERENCE_ASSETS vs
// VOLUME_SOURCE_POOLS) are independent - a token being priced does not
// imply its pool is indexed for volume, and vice versa.
import type { VolumeCalculationInput } from "@/lib/database/schema";

export type { VolumeCalculationInput };

// The on-chain volume-source adapter kinds this phase implements and
// verifies end-to-end (lib/onchain/volume/uniswap-v2.ts,
// lib/onchain/volume/uniswap-v3.ts, added Phase 5.6). Deliberately a
// closed union, matching lib/onchain/pricing/types.ts's own
// PriceSourceKind precedent: adding a third adapter kind means adding a
// member here and a matching arm everywhere this type is switched on, so
// an incomplete rollout fails to compile instead of silently falling
// through a default case.
export type VolumeSourceKind = "uniswap-v2" | "uniswap-v3";

// One decoded Swap event, ALREADY NORMALIZED to a single common shape
// regardless of which protocol produced it. For V2, this is the raw shape
// every genuine IUniswapV2Pair-compatible
// Swap(sender, amount0In, amount1In, amount0Out, amount1Out, to) event
// decodes into directly. For V3 (Phase 5.6), whose own Swap event instead
// carries a single SIGNED amount0/amount1 pair, decodeV3SwapLog
// (uniswap-v3.ts) normalizes that signed pair into this same
// amount0In/amount1In/amount0Out/amount1Out shape BEFORE this type is ever
// constructed - see that function's own comment for exactly how, and why
// that normalization is a correct, lossless representation of the V3
// event's real semantics, not a "pretend it's V2" shortcut. Never includes
// USD values - pricing is applied later, separately, so a pricing failure
// can never affect whether this shape itself is considered valid.
export interface DecodedSwapEvent {
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: Date;
  sender: string;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  // V3-only (Phase 5.6) - undefined for every V2 event, since V2's Swap
  // event carries none of these. Preserved verbatim from the V3 Swap event
  // for provenance/future methodology (see docs/native-data.md's own
  // "Native Uniswap V3 volume/fees" section for what this phase does and
  // does NOT yet use them for) - never derived, never assumed, never
  // substituted with current state for a historical row.
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
}

// The result of pricing one decoded swap - the USD value of whichever
// side(s) were the trade's INPUT (see uniswap-v2.ts's own comment on the
// "input-side value, never both sides summed as if they were separate
// trades" convention). `pricedSides` normally has exactly one entry (a V2
// swap has exactly one input token in the overwhelming majority of real
// swaps - confirmed empirically against live Swap events, see
// uniswap-v2.test.ts); a second entry only appears for the rare/unusual
// case of a transaction with both amount0In and amount1In nonzero, whose
// USD values are summed once each, not double-counted. `ok: false` means
// this swap's raw data is fine (it's already in DecodedSwapEvent form) but
// a price for its input token(s) wasn't available this run - the swap is
// excluded from volume/fee totals, never assumed to be worth $0.
export interface PricedSwapSide {
  symbol: string;
  priceUsd: string;
  priceSource: string;
}

export type SwapVolumeResult = { ok: true; volumeUsd: string; pricedSides: PricedSwapSide[] } | { ok: false; error: string };
