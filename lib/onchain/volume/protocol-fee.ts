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
// why" outcome. See resolveProtocolRevenue below for both branches,
// including the one this phase's real config doesn't currently exercise.
export const V2_FACTORY_ABI = parseAbi(["function feeTo() view returns (address)"]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ProtocolFeeState {
  factoryAddress: string;
  feeToAddress: string;
  active: boolean;
}

// Reads the live feeTo() state for one V2-style factory - a real RPC read,
// through the same withResilientClient every other on-chain read in this
// app uses.
export async function readV2ProtocolFeeState(chainSlug: string, factoryAddress: string): Promise<ProtocolFeeState> {
  const feeToAddress = await withResilientClient(chainSlug, (client) =>
    client.readContract({ address: factoryAddress as Address, abi: V2_FACTORY_ABI, functionName: "feeTo" }),
  );
  return {
    factoryAddress,
    feeToAddress,
    active: feeToAddress.toLowerCase() !== ZERO_ADDRESS,
  };
}

export type ProtocolRevenueOutcome =
  | { available: true; revenueUsd: string; reason: string }
  | { available: false; reason: string };

// Pure - the actual available/unavailable decision, given an already-read
// ProtocolFeeState, directly unit-testable without an RPC call. Only ever
// returns `available: true` for the verified-zero case - never for the
// active case, regardless of how volume/fees looked this run, since
// "active" alone says nothing about how much has actually been realized.
export function resolveProtocolRevenue(feeState: ProtocolFeeState): ProtocolRevenueOutcome {
  if (!feeState.active) {
    return {
      available: true,
      revenueUsd: "0",
      reason: `factory.feeTo() (${feeState.factoryAddress}) is the zero address - the protocol-fee mechanism is verifiably inactive for this deployment, so captured revenue is exactly zero, not merely unmeasured`,
    };
  }
  return {
    available: false,
    reason:
      `factory.feeTo() (${feeState.factoryAddress}) = ${feeState.feeToAddress} (active) - realized protocol revenue requires tracking every Mint/Burn event for this pool and its kLast state to compute the sqrt(k) growth each one captured, which this phase does not implement`,
  };
}
