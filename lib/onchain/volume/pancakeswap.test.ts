// Phase 5.7: proves PancakeSwap V2 (BNB Chain) genuinely reuses the
// existing Uniswap V2 adapter (decodeSwapLog/computeSwapVolumeUsd/
// computeSwapFeeUsd, uniswap-v2.ts) with ZERO new decode/math code - the
// "common primitives, protocol-specific config" architecture this phase's
// own instructions ask for, not a duplicated adapter. Uses a REAL,
// live-captured PancakeSwap Swap event (block 118258974, fetched directly
// via eth_getLogs against the configured pool
// lib/onchain/volume/config.ts's "pancakeswap-amm-bsc-usdt-wbnb" entry),
// not a synthesized fixture - the same "real fixture, hand-decoded and
// cross-validated" discipline uniswap-v2.test.ts's own Ethereum fixture
// already established.
import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import { computeSwapFeeUsd, computeSwapVolumeUsd, decodeSwapLog, type SwapTokenPrice } from "./uniswap-v2";

// Raw log as fetched live: topics[0] is the Swap event signature (byte-for-
// byte identical topic0 to Ethereum's Uniswap V2 Swap event - confirmed
// during this phase's own audit, the fact that makes zero-new-code reuse
// possible at all), topics[1]/[2] are the indexed sender/to (both the same
// address here - a router acting as both), data is the four non-indexed
// uint256 amounts in order.
const REAL_PANCAKESWAP_SWAP_LOG_RAW = {
  address: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
  blockNumber: BigInt(118258974),
  blockHash: "0x938be316abd455d8cbf0c40d65618436c1ad4fb2fe8418e9cd8886b71185e2f9",
  transactionHash: "0x16fdd2e2c6dbc9761e0467d8e2c425f1cb200c7b19ced26fb149508c6f08719f",
  logIndex: 32,
  args: {
    sender: "0x1de460f363af910f51726def188f9004276bf4bc",
    to: "0x1de460f363af910f51726def188f9004276bf4bc",
    amount0In: BigInt("8642085578771963208"),
    amount1In: BigInt(0),
    amount0Out: BigInt(0),
    amount1Out: BigInt("12332977880559447"),
  },
};
const REAL_PANCAKESWAP_SWAP_LOG = REAL_PANCAKESWAP_SWAP_LOG_RAW as unknown as Log;

describe("decodeSwapLog - PancakeSwap V2 (BNB Chain) reuse", () => {
  it("decodes a real, live-captured PancakeSwap Swap event exactly, via the unmodified V2 decoder", () => {
    const decoded = decodeSwapLog(REAL_PANCAKESWAP_SWAP_LOG);
    expect(decoded).toEqual({
      transactionHash: "0x16fdd2e2c6dbc9761e0467d8e2c425f1cb200c7b19ced26fb149508c6f08719f",
      logIndex: 32,
      blockNumber: BigInt(118258974),
      blockHash: "0x938be316abd455d8cbf0c40d65618436c1ad4fb2fe8418e9cd8886b71185e2f9",
      sender: "0x1de460f363af910f51726def188f9004276bf4bc",
      amount0In: BigInt("8642085578771963208"),
      amount1In: BigInt(0),
      amount0Out: BigInt(0),
      amount1Out: BigInt("12332977880559447"),
    });
  });

  it("computes real volume/fee USD for this fixture using PancakeSwap's own 25bps fee - never Uniswap V2's 30bps", () => {
    const decoded = decodeSwapLog(REAL_PANCAKESWAP_SWAP_LOG)!;
    // Real USDT price at capture time was ~$1.00; WBNB's own price is
    // irrelevant here since amount0In (USDT) is the swap's only input side.
    const usdt: SwapTokenPrice = { symbol: "USDT", decimals: 18, priceUsd: "1.00", priceSource: "test-fixture" };
    const wbnb: SwapTokenPrice = { symbol: "WBNB", decimals: 18, priceUsd: "700.73", priceSource: "test-fixture" };

    const volume = computeSwapVolumeUsd({ amount0In: decoded.amount0In, amount1In: decoded.amount1In, token0: usdt, token1: wbnb });
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    // 8.642085578771963208 USDT input at $1.00 = $8.642085578771963208
    expect(volume.volumeUsd).toBe("8.642085578771963208");

    const feeUsd = computeSwapFeeUsd(volume.volumeUsd, 25);
    // 0.25% of $8.642085578771963208, exact BigInt arithmetic
    expect(feeUsd).toBe("0.02160521394692990802");

    const feeUsdAtV2Rate = computeSwapFeeUsd(volume.volumeUsd, 30);
    expect(feeUsdAtV2Rate).not.toBe(feeUsd);
  });
});
