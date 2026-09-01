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

// Phase 5.11's V3 discovery expansion. The canonical IUniswapV3Factory
// PoolCreated event - see
// https://github.com/Uniswap/v3-core's own IUniswapV3Factory.sol for the
// authoritative definition, the same source Phase 5.6's own V3 Swap event
// comment already points to. Live-verified this phase against the real,
// canonical Uniswap V3 Factory (0x1F98431c8aD98523631AE4a59f267346ea31F984,
// already independently verified elsewhere in this app - see
// lib/onchain/config.ts's own uniswap-v3-eth-usdc-weth-005 entry): fetched
// real PoolCreated logs and confirmed topic0
// (0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118) and
// the exact 3-indexed/2-data-field shape below against real, live data -
// not assumed from documentation alone, the same discipline
// PAIR_CREATED_EVENT_SIGNATURE's own verification followed.
//
// Genuinely different from V2's PairCreated, not a copy: `fee` is a third
// INDEXED parameter (V3's factory can deploy the SAME token pair at
// multiple, independent fee tiers - each a distinct pool with its own
// address, not a duplicate), and `tickSpacing` (derivable from fee for the
// canonical factory's own standard tiers, but read directly from the event
// rather than hardcoding that mapping) appears only in the non-indexed
// data. Every parameter is named for the identical reason
// PAIR_CREATED_EVENT_SIGNATURE's own comment documents (an unnamed
// parameter anywhere in the signature makes viem's decodeEventLog return
// positional args for the WHOLE event, not just the unnamed field) -
// avoided from the start here rather than rediscovered live a second time.
export const POOL_CREATED_EVENT_SIGNATURE =
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)";

// One decoded PoolCreated event. Deliberately does NOT include tickSpacing
// - nothing downstream of discovery needs it (V3 volume/fee math already
// only consumes feeBps, converted from feeTier - see
// lib/onchain/volume/uniswap-v3.ts), and validate.ts independently
// cross-checks feeTier itself against the pool's own live fee() call
// rather than trusting tickSpacing's derived relationship to it.
export interface DecodedPoolCreated {
  token0: string;
  token1: string;
  feeTier: number;
  poolAddress: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

// Same "return null, never throw, never fabricate" contract as
// decodePairCreatedLog above. `fee` decodes as a plain JS `number` (not
// `bigint`) - confirmed live against real PoolCreated logs, the same
// uint24-decodes-as-number behavior Phase 5.6 already established for V3's
// own `tick` field (int24) in the Swap event; uint24's real range (0 to
// 16,777,215) is nowhere near Number.MAX_SAFE_INTEGER, so this is exact,
// not the "unsafe Number() on a uint256 token amount" this app's
// conventions forbid elsewhere.
export function decodePoolCreatedLog(log: Log): DecodedPoolCreated | null {
  if (log.blockNumber == null || log.blockHash == null || log.transactionHash == null || log.logIndex == null) {
    return null;
  }

  const args = (log as { args?: Record<string, unknown> }).args;
  if (!args) return null;
  const { token0, token1, fee, pool } = args;
  if (typeof token0 !== "string" || typeof token1 !== "string" || typeof fee !== "number" || !Number.isInteger(fee) || typeof pool !== "string") {
    return null;
  }

  return {
    token0,
    token1,
    feeTier: fee,
    poolAddress: pool,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}
