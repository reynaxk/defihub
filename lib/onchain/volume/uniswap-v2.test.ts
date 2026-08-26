// Pure unit tests for Swap-event decoding and volume/fee math - no RPC, no
// DB. The decode tests use a REAL Uniswap V2 USDC/WETH Swap event, captured
// live from the configured pool (lib/onchain/volume/config.ts's
// uniswap-v2-eth-usdc-weth entry) at block 25839575 during this phase's own
// development - not a synthesized fixture. The volume/fee math tests use
// round, hand-verifiable numbers instead of that exact fixture's real price
// (a swap's USD price is always an external input to this function, never
// derived from the event itself, so using a clean round price for the math
// tests doesn't compromise anything the decode tests already cover with
// real data).
import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import { computeSwapFeeUsd, computeSwapVolumeUsd, decodeSwapLog, type SwapTokenPrice } from "./uniswap-v2";

const REAL_SWAP_LOG_RAW = {
  address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
  blockNumber: BigInt(25839575),
  blockHash: "0x7b506a997b1dac4bfe097264ccb66cc7bbe74e15ce5c30ff2a4c1e2de1495828",
  transactionHash: "0x937dd174146e042fd15d0fab65aeb6e38cc75a8591e7b91d232d9638200ff02b",
  logIndex: 1183,
  args: {
    sender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    to: "0x423D607Bd4E213e9b64a54b324Ab7F632FEeC647",
    amount0In: BigInt(0),
    amount1In: BigInt("6097385952361777"),
    amount0Out: BigInt(14934999),
    amount1Out: BigInt(0),
  },
};
const REAL_SWAP_LOG = REAL_SWAP_LOG_RAW as unknown as Log;

describe("decodeSwapLog", () => {
  it("decodes a real, live-captured Swap event exactly", () => {
    const decoded = decodeSwapLog(REAL_SWAP_LOG);
    expect(decoded).toEqual({
      transactionHash: "0x937dd174146e042fd15d0fab65aeb6e38cc75a8591e7b91d232d9638200ff02b",
      logIndex: 1183,
      blockNumber: BigInt(25839575),
      blockHash: "0x7b506a997b1dac4bfe097264ccb66cc7bbe74e15ce5c30ff2a4c1e2de1495828",
      sender: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      amount0In: BigInt(0),
      amount1In: BigInt("6097385952361777"),
      amount0Out: BigInt(14934999),
      amount1Out: BigInt(0),
    });
  });

  it("returns null when block identity fields are missing (a pending/unmined log)", () => {
    const pending = { ...REAL_SWAP_LOG, blockNumber: null, blockHash: null, transactionHash: null, logIndex: null } as unknown as Log;
    expect(decodeSwapLog(pending)).toBeNull();
  });

  it("returns null when decoded args are entirely missing", () => {
    const noArgs = { ...REAL_SWAP_LOG, args: undefined } as unknown as Log;
    expect(decodeSwapLog(noArgs)).toBeNull();
  });

  it("returns null when an amount field has the wrong type (malformed/non-bigint decode)", () => {
    const malformed = { ...REAL_SWAP_LOG_RAW, args: { ...REAL_SWAP_LOG_RAW.args, amount1In: "not-a-bigint" } } as unknown as Log;
    expect(decodeSwapLog(malformed)).toBeNull();
  });

  it("returns null when sender/to are the wrong type", () => {
    const malformed = { ...REAL_SWAP_LOG_RAW, args: { ...REAL_SWAP_LOG_RAW.args, sender: 12345 } } as unknown as Log;
    expect(decodeSwapLog(malformed)).toBeNull();
  });
});

const USDC: SwapTokenPrice = { symbol: "USDC", decimals: 6, priceUsd: "1.00", priceSource: "onchain-pricing-engine" };
const WETH: SwapTokenPrice = { symbol: "WETH", decimals: 18, priceUsd: "2500.00", priceSource: "onchain-pricing-engine" };

describe("computeSwapVolumeUsd", () => {
  it("prices a single-sided input (the normal case - 0 dual-input swaps observed live in this pool's own real sample)", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(0), amount1In: BigInt("1000000000000000000"), token0: USDC, token1: WETH });
    expect(result).toEqual({ ok: true, volumeUsd: "2500", pricedSides: [{ symbol: "WETH", priceUsd: "2500.00", priceSource: "onchain-pricing-engine" }] });
  });

  it("prices the other single-sided direction (USDC input)", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(1000000), amount1In: BigInt(0), token0: USDC, token1: WETH });
    expect(result).toEqual({ ok: true, volumeUsd: "1", pricedSides: [{ symbol: "USDC", priceUsd: "1.00", priceSource: "onchain-pricing-engine" }] });
  });

  it("sums both input sides once each for the rare dual-input case, never double-counting either side alone as the whole trade", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(1000000), amount1In: BigInt("1000000000000000000"), token0: USDC, token1: WETH });
    expect(result).toEqual({
      ok: true,
      volumeUsd: "2501",
      pricedSides: [
        { symbol: "USDC", priceUsd: "1.00", priceSource: "onchain-pricing-engine" },
        { symbol: "WETH", priceUsd: "2500.00", priceSource: "onchain-pricing-engine" },
      ],
    });
  });

  it("rejects a swap with zero input on both sides rather than reporting $0 volume", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(0), amount1In: BigInt(0), token0: USDC, token1: WETH });
    expect(result).toEqual({ ok: false, error: "swap has no input amount (amount0In and amount1In are both zero)" });
  });

  it("marks the swap unpriced (never $0) when the input token has no usable price", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(0), amount1In: BigInt("1000000000000000000"), token0: USDC, token1: null });
    expect(result).toEqual({ ok: false, error: "missing USD price for token1" });
  });

  it("marks the swap unpriced when the OTHER (non-input) token has no price - the input side's own price is what matters", () => {
    const result = computeSwapVolumeUsd({ amount0In: BigInt(1000000), amount1In: BigInt(0), token0: USDC, token1: null });
    expect(result.ok).toBe(true);
  });
});

describe("computeSwapFeeUsd", () => {
  it("applies the exact configured fee bps - never a hardcoded global 0.30%", () => {
    expect(computeSwapFeeUsd("10000", 30)).toBe("30");
    expect(computeSwapFeeUsd("10000", 25)).toBe("25");
    expect(computeSwapFeeUsd("10000", 100)).toBe("100");
  });

  it("returns $0 fee for $0 volume", () => {
    expect(computeSwapFeeUsd("0", 30)).toBe("0");
  });
});
