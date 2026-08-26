// Pure unit tests for V3 Swap-event decoding - no RPC, no DB. The primary
// decode test uses a REAL Uniswap V3 USDC/WETH 0.05% Swap event, captured
// live from the configured pool (lib/onchain/volume/config.ts's
// uniswap-v3-eth-usdc-weth-005 entry) at block 25841071 during this
// phase's own development - not a synthesized fixture. Cross-validated by
// hand: 290.968404 USDC in for 0.1176124677543054 WETH out implies a price
// of ~$2473.6/WETH, consistent with real market conditions at the time.
// The volume/fee MATH itself is exercised in math.test.ts-equivalent
// coverage already in uniswap-v2.test.ts (computeSwapVolumeUsd/
// computeSwapFeeUsd are shared, protocol-neutral code - see math.ts's own
// module comment); this file only needs to prove decodeV3SwapLog produces
// correctly-normalized input to that shared math, not re-prove the math
// itself.
import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import { computeSwapVolumeUsd } from "./math";
import { decodeV3SwapLog } from "./uniswap-v3";
import type { SwapTokenPrice } from "./math";

const REAL_V3_SWAP_LOG_RAW = {
  address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  blockNumber: BigInt(25841071),
  blockHash: "0x63e1eded1acde171bf583c45afff5c055a639d49e0e32ff5fc28ecb72df11946",
  transactionHash: "0xe97ab26e3f42a26e677b580397015ec2ec77bb0702da55f36d45ac076cc7a404",
  logIndex: 115,
  args: {
    sender: "0x6487986a78b126538746937fbd25516971129b3a",
    recipient: "0x6487986a78b126538746937fbd25516971129b3a",
    // USDC (token0) flowed IN (positive) - the trader paid 290.968404 USDC.
    amount0: BigInt("290968404"),
    // WETH (token1) flowed OUT (negative) - the trader received ~0.1176 WETH.
    amount1: BigInt("-117612467754305400"),
    sqrtPriceX96: BigInt("1593278375175708285337695076763573"),
    liquidity: BigInt("4399000621040250994"),
    // Verified live: viem/abitype decodes int24 as a plain JS number, not
    // bigint (unlike amount0/amount1/sqrtPriceX96/liquidity above) - this
    // fixture matches that real behavior exactly, not an assumption.
    tick: 198189,
  },
};
const REAL_V3_SWAP_LOG = REAL_V3_SWAP_LOG_RAW as unknown as Log;

describe("decodeV3SwapLog", () => {
  it("decodes a real, live-captured V3 Swap event exactly, normalizing the signed amount0/amount1 pair into the shared amount0In/amount1In/amount0Out/amount1Out shape", () => {
    const decoded = decodeV3SwapLog(REAL_V3_SWAP_LOG);
    expect(decoded).toEqual({
      transactionHash: "0xe97ab26e3f42a26e677b580397015ec2ec77bb0702da55f36d45ac076cc7a404",
      logIndex: 115,
      blockNumber: BigInt(25841071),
      blockHash: "0x63e1eded1acde171bf583c45afff5c055a639d49e0e32ff5fc28ecb72df11946",
      sender: "0x6487986a78b126538746937fbd25516971129b3a",
      // amount0 was positive (290968404) -> amount0In, amount0Out stays 0.
      amount0In: BigInt("290968404"),
      amount0Out: BigInt(0),
      // amount1 was negative (-117612467754305400) -> amount1Out (negated
      // back to a positive magnitude), amount1In stays 0.
      amount1In: BigInt(0),
      amount1Out: BigInt("117612467754305400"),
      sqrtPriceX96: BigInt("1593278375175708285337695076763573"),
      liquidity: BigInt("4399000621040250994"),
      tick: 198189,
    });
  });

  it("correctly normalizes the opposite direction (token1/WETH in, token0/USDC out)", () => {
    const opposite = {
      ...REAL_V3_SWAP_LOG_RAW,
      args: { ...REAL_V3_SWAP_LOG_RAW.args, amount0: BigInt("-290968404"), amount1: BigInt("117612467754305400") },
    } as unknown as Log;
    const decoded = decodeV3SwapLog(opposite);
    expect(decoded?.amount0In).toBe(BigInt(0));
    expect(decoded?.amount0Out).toBe(BigInt("290968404"));
    expect(decoded?.amount1In).toBe(BigInt("117612467754305400"));
    expect(decoded?.amount1Out).toBe(BigInt(0));
  });

  it("correctly decodes a negative tick (price below 1:1 in raw tick terms - a real, ordinary case, not an edge case)", () => {
    const negativeTick = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: -198189 } } as unknown as Log;
    expect(decodeV3SwapLog(negativeTick)?.tick).toBe(-198189);
  });

  it("accepts a tick at the exact int24 boundary values", () => {
    const maxTick = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: 8388607 } } as unknown as Log;
    const minTick = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: -8388608 } } as unknown as Log;
    expect(decodeV3SwapLog(maxTick)?.tick).toBe(8388607);
    expect(decodeV3SwapLog(minTick)?.tick).toBe(-8388608);
  });

  it("returns null for a tick outside int24's real range - never silently truncated", () => {
    const tooHigh = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: 8388608 } } as unknown as Log;
    const tooLow = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: -8388609 } } as unknown as Log;
    // A non-integer tick (a decode bug that shouldn't happen, but never
    // assumed impossible) must also be rejected, not silently floored.
    const nonInteger = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, tick: 198189.5 } } as unknown as Log;
    expect(decodeV3SwapLog(tooHigh)).toBeNull();
    expect(decodeV3SwapLog(tooLow)).toBeNull();
    expect(decodeV3SwapLog(nonInteger)).toBeNull();
  });

  it("returns null when block identity fields are missing (a pending/unmined log)", () => {
    const pending = { ...REAL_V3_SWAP_LOG_RAW, blockNumber: null, blockHash: null, transactionHash: null, logIndex: null } as unknown as Log;
    expect(decodeV3SwapLog(pending)).toBeNull();
  });

  it("returns null when decoded args are entirely missing", () => {
    const noArgs = { ...REAL_V3_SWAP_LOG_RAW, args: undefined } as unknown as Log;
    expect(decodeV3SwapLog(noArgs)).toBeNull();
  });

  it("returns null when a field has the wrong type (malformed/non-bigint decode, e.g. sqrtPriceX96)", () => {
    const malformed = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, sqrtPriceX96: "not-a-bigint" } } as unknown as Log;
    expect(decodeV3SwapLog(malformed)).toBeNull();
  });

  it("returns null when sender is the wrong type", () => {
    const malformed = { ...REAL_V3_SWAP_LOG_RAW, args: { ...REAL_V3_SWAP_LOG_RAW.args, sender: 12345 } } as unknown as Log;
    expect(decodeV3SwapLog(malformed)).toBeNull();
  });
});

const USDC: SwapTokenPrice = { symbol: "USDC", decimals: 6, priceUsd: "1.00", priceSource: "onchain-pricing-engine" };
const WETH: SwapTokenPrice = { symbol: "WETH", decimals: 18, priceUsd: "2473.60", priceSource: "onchain-pricing-engine" };

describe("decoded V3 swap feeding into the shared computeSwapVolumeUsd", () => {
  it("prices the real fixture's USDC input side correctly", () => {
    const decoded = decodeV3SwapLog(REAL_V3_SWAP_LOG)!;
    const result = computeSwapVolumeUsd({ amount0In: decoded.amount0In, amount1In: decoded.amount1In, token0: USDC, token1: WETH });
    expect(result).toEqual({ ok: true, volumeUsd: "290.968404", pricedSides: [{ symbol: "USDC", priceUsd: "1.00", priceSource: "onchain-pricing-engine" }] });
  });

  it("prices a WETH-input swap correctly (the other direction)", () => {
    const result = computeSwapVolumeUsd({
      amount0In: BigInt(0),
      amount1In: BigInt("117612467754305400"),
      token0: USDC,
      token1: WETH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 0.1176124677543054 WETH * 2473.60 ~= 290.97
      expect(Number(result.volumeUsd)).toBeCloseTo(290.97, 1);
    }
  });
});
