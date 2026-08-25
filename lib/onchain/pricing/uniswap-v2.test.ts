// Pure unit tests for deriveV2Price - no RPC, no multicall, plain BigInts
// and exact decimal strings in and out. Mirrors verify-pool.test.ts's own
// convention of testing only the pure calculation layer directly.
import { describe, expect, it } from "vitest";
import { deriveV2Price } from "./uniswap-v2";

const MIN_LIQUIDITY = "10000";

describe("deriveV2Price", () => {
  it("computes a normal pair's price correctly - WETH priced against a $1.00 USDC reference", () => {
    // ~10.026M USDC (6 decimals) against ~4102.48 WETH (18 decimals) -
    // implies roughly $2444.40/WETH, the real reserve ratio verified live
    // on-chain for the USDC/WETH V2 pool this app's config actually uses.
    const result = deriveV2Price({
      pricedReserve: BigInt("4102476795628499120331"),
      pricedDecimals: 18,
      pairedReserve: BigInt("10026031352833"),
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const price = Number(result.priceUsd);
      expect(price).toBeGreaterThan(2440);
      expect(price).toBeLessThan(2450);
      // Liquidity is ~2x the paired (USDC) side's USD value - ~$20.05M.
      const liquidity = Number(result.liquidityUsd);
      expect(liquidity).toBeGreaterThan(20_000_000);
      expect(liquidity).toBeLessThan(20_100_000);
    }
  });

  it("produces the reciprocal relationship when priced/paired sides are swapped (reversed token order)", () => {
    const params = {
      pricedReserve: BigInt("4102476795628499120331"), // WETH
      pricedDecimals: 18,
      pairedReserve: BigInt("10026031352833"), // USDC
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    };
    const wethInUsdc = deriveV2Price(params);

    // Same pool, same reserves, but now pricing USDC in terms of WETH -
    // exactly what "the pool's other token is the priced one" means at this
    // layer (engine.ts decides which side is which based on token0()/
    // token1(), not this function).
    const usdcInWeth = deriveV2Price({
      pricedReserve: params.pairedReserve,
      pricedDecimals: params.pairedDecimals,
      pairedReserve: params.pricedReserve,
      pairedDecimals: params.pricedDecimals,
      pairedPriceUsd: (wethInUsdc as { priceUsd: string }).priceUsd,
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(wethInUsdc.ok).toBe(true);
    expect(usdcInWeth.ok).toBe(true);
    if (usdcInWeth.ok) {
      // Re-deriving USDC's price by going "there and back" through WETH's
      // own just-derived price should land back near $1.00 - confirms the
      // reserve-ratio math is genuinely symmetric, not accidentally
      // one-directional.
      const price = Number(usdcInWeth.priceUsd);
      expect(price).toBeGreaterThan(0.99);
      expect(price).toBeLessThan(1.01);
    }
  });

  it("handles differing decimals correctly - an 8-decimal priced token (WBTC) against an 18-decimal reference (WETH)", () => {
    // ~54.66 WBTC (8 decimals) against ~1758.76 WETH (18 decimals) -
    // implies roughly 32.17 WETH per WBTC, the real reserve ratio verified
    // live on-chain for the WBTC/WETH V2 pool.
    const result = deriveV2Price({
      pricedReserve: BigInt("5466454870"),
      pricedDecimals: 8,
      pairedReserve: BigInt("1758756430994561570708"),
      pairedDecimals: 18,
      pairedPriceUsd: "2444.40",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 32.17 WETH * $2444.40/WETH =~ $78,633
      const price = Number(result.priceUsd);
      expect(price).toBeGreaterThan(75000);
      expect(price).toBeLessThan(82000);
    }
  });

  it("reflects a real stablecoin peg deviation exactly, never assuming $1.00 for the priced side", () => {
    // ~1.6657M USDC (6 decimals) against ~1.6681M USDT (6 decimals) - the
    // real reserve ratio verified live on-chain for the USDC/USDT V2 pool,
    // implying USDT trades at a small discount to USDC.
    const result = deriveV2Price({
      pricedReserve: BigInt("1668079658398"),
      pricedDecimals: 6,
      pairedReserve: BigInt("1665742976859"),
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.priceUsd).not.toBe("1.00");
      expect(result.priceUsd).not.toBe("1");
      const price = Number(result.priceUsd);
      expect(price).toBeGreaterThan(0.99);
      expect(price).toBeLessThan(1.0);
    }
  });

  it("fails explicitly on a pool with zero reserves, never treating it as an infinite or zero price", () => {
    const result = deriveV2Price({
      pricedReserve: BigInt(0),
      pricedDecimals: 18,
      pairedReserve: BigInt("1000000"),
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/zero/);
  });

  it("rejects a pool below the configured minimum liquidity threshold", () => {
    // A genuinely tiny pool: 1 WETH against 1 USDC-equivalent ($1) -
    // nowhere near the $10,000 floor.
    const result = deriveV2Price({
      pricedReserve: BigInt("1000000000000000000"),
      pricedDecimals: 18,
      pairedReserve: BigInt("1000000"),
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/liquidity/);
  });

  it("rejects an invalid (non-decimal) paired price string rather than silently misparsing it", () => {
    const result = deriveV2Price({
      pricedReserve: BigInt("1000000000000000000"),
      pricedDecimals: 18,
      pairedReserve: BigInt("1000000000"),
      pairedDecimals: 6,
      pairedPriceUsd: "not-a-number",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid/);
  });

  it("rejects decimals exceeding this calculation's fixed-point scale", () => {
    const result = deriveV2Price({
      pricedReserve: BigInt("1000000000000000000"),
      pricedDecimals: 31,
      pairedReserve: BigInt("1000000000"),
      pairedDecimals: 6,
      pairedPriceUsd: "1.00",
      minLiquidityUsd: MIN_LIQUIDITY,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/decimals/);
  });
});
