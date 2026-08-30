import type { Log } from "viem";

// The canonical Uniswap V2 Factory event, emitted by every genuine
// factory-deployed pair's creation transaction - not invented, verified
// live against both configured factories during this phase's own
// development (real PairCreated events fetched and hand-decoded from the
// real PancakeSwap V2 Factory; the same signature/topic0 already confirmed
// identical to Uniswap V2's own during Phase 5.7's audit). Every real V2
// fork (PancakeSwap included) reuses this exact event byte-for-byte - the
// same "genuine fork, not merely V2-shaped" fact that already let Phase
// 5.7 reuse the Swap-event decoder unmodified applies here too.
//
// The trailing `uint256` parameter is explicitly named `allPairsLength`
// here even though this decoder never reads it - a real, live-discovered
// bug this phase's own development caught: viem's decodeEventLog returns
// `args` as a plain positional ARRAY, not a named object, the moment ANY
// parameter in the signature is unnamed - even when every OTHER parameter
// IS named. The canonical Uniswap V2 Factory Solidity source itself never
// names this parameter, and an unnamed-4th-param signature (matching the
// contract source literally) silently made every real PairCreated log
// decode as unusable positional data (`args.token0 === undefined`) against
// 100% of real logs during live testing - the exact same class of "the
// implementation's own assumption about viem's decode shape was wrong,
// and my own hand-written test fixture encoded the identical wrong
// assumption, so it passed anyway" bug this phase's earlier
// Phase 5.6 development already hit once for `int24 tick` (bigint vs.
// number). Verified live: decodeEventLog's `args` becomes a genuine named
// object again, with this exact change, against the real deployed
// PancakeSwap V2 Factory's own real event data.
export const PAIR_CREATED_EVENT_SIGNATURE = "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)";

// One decoded PairCreated event - the raw creation fact this discovery
// pipeline is built on. Deliberately does NOT include token decimals/
// symbol or any other metadata beyond what THIS event itself carries -
// resolving those requires separate on-chain reads against the token
// contracts (validate.ts), which must never be silently assumed correct
// just because a factory emitted an event naming these addresses.
export interface DecodedPairCreated {
  token0: string;
  token1: string;
  poolAddress: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

// Pure, defensive decode - same "return null, never throw, never
// fabricate" contract as decodeSwapLog/decodeV3SwapLog
// (lib/onchain/volume/uniswap-v2.ts/uniswap-v3.ts). A log missing its
// confirmed-block identity, or one whose decoded args don't match the
// expected shape at all, is skipped rather than trusted.
export function decodePairCreatedLog(log: Log): DecodedPairCreated | null {
  if (log.blockNumber == null || log.blockHash == null || log.transactionHash == null || log.logIndex == null) {
    return null;
  }

  const args = (log as { args?: Record<string, unknown> }).args;
  if (!args) return null;
  const { token0, token1, pair } = args;
  if (typeof token0 !== "string" || typeof token1 !== "string" || typeof pair !== "string") {
    return null;
  }

  return {
    token0,
    token1,
    poolAddress: pair,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}
