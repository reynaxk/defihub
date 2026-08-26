// Pure unit tests for engine.ts's extracted decision functions - no RPC, no
// DB (see engine.ts's own module comment for why the RPC-touching
// orchestration itself isn't unit-tested directly).
import { describe, expect, it } from "vitest";
import { computeSafeHead, effectiveStartBlock } from "./engine";
import type { VolumeSourcePool } from "./config";

function fakePool(overrides: Partial<VolumeSourcePool> = {}): VolumeSourcePool {
  return {
    key: "test-pool",
    chainSlug: "ethereum",
    poolAddress: "0xpool",
    sourceKind: "uniswap-v2",
    token0: { address: "0xusdc", symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
    token1: { address: "0xweth", symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    factoryAddress: "0xfactory",
    feeBps: 30,
    feeVerification: "test",
    startBlock: BigInt(1000),
    ...overrides,
  };
}

describe("computeSafeHead", () => {
  it("subtracts the chain's own confirmation depth from the current head", () => {
    // ethereum's confirmationsFor is 12 (lib/chains/confirmations.ts)
    expect(computeSafeHead("ethereum", BigInt(1000))).toBe(BigInt(988));
  });

  it("clamps at zero rather than going negative for a chain still near genesis", () => {
    expect(computeSafeHead("ethereum", BigInt(5))).toBe(BigInt(0));
  });

  it("uses a deeper confirmation depth for a chain that requires one (polygon: 128)", () => {
    expect(computeSafeHead("polygon", BigInt(1000))).toBe(BigInt(872));
  });
});

describe("effectiveStartBlock", () => {
  it("honors the configured startBlock unchanged when it already falls within the safe recent window", () => {
    // currentBlock 1000, confirmations 12 -> safeHead 988, lookback 80 ->
    // recentFloor 908. A configured startBlock of 950 is already inside
    // that window, so nothing should be skipped.
    const pool = fakePool({ startBlock: BigInt(950) });
    const result = effectiveStartBlock(pool, BigInt(1000));
    expect(result.startBlock).toBe(BigInt(950));
    expect(result.skippedBlocks).toBe(BigInt(0));
  });

  it("raises a stale configured startBlock up to the confirmed-head-relative safe floor, reporting exactly how much was skipped", () => {
    // The real bug this fix addresses: a pool configured with a startBlock
    // that has since drifted far behind the current chain head (exactly
    // what happened live during this phase's own development - see
    // engine.ts's own DEFAULT_VOLUME_CHUNK_SIZE/SAFE_LOOKBACK_BLOCKS
    // comments). currentBlock 100000, confirmations 12 -> safeHead 99988,
    // lookback 80 -> recentFloor 99908. A configured startBlock of 1000 is
    // far below that floor.
    const pool = fakePool({ startBlock: BigInt(1000) });
    const result = effectiveStartBlock(pool, BigInt(100000));
    expect(result.startBlock).toBe(BigInt(99908));
    expect(result.skippedBlocks).toBe(BigInt(99908) - BigInt(1000));
    expect(result.skippedBlocks > BigInt(0)).toBe(true);
  });

  it("derives the safe floor from the CONFIRMED head, not the raw current head - a chain with deep confirmations shifts the floor down accordingly", () => {
    // polygon requires 128 confirmations (vs. ethereum's 12) - the same
    // currentBlock must produce a correspondingly lower safe floor.
    const pool = fakePool({ chainSlug: "polygon", startBlock: BigInt(1000) });
    const result = effectiveStartBlock(pool, BigInt(100000));
    // safeHead = 100000 - 128 = 99872; recentFloor = 99872 - 80 = 99792
    expect(result.startBlock).toBe(BigInt(99792));
  });

  it("clamps the effective start at zero for a chain still very close to genesis, never going negative", () => {
    const pool = fakePool({ startBlock: BigInt(0) });
    const result = effectiveStartBlock(pool, BigInt(10));
    expect(result.startBlock).toBe(BigInt(0));
    expect(result.skippedBlocks).toBe(BigInt(0));
  });

  it("never lowers an already-recent configured startBlock even if it is ABOVE the safe floor", () => {
    // startBlock closer to head than the floor itself - effectiveStartBlock
    // must never pull it backward, only ever forward (skip ahead), since
    // pulling it backward would mean re-scanning blocks the config never
    // asked for.
    const pool = fakePool({ startBlock: BigInt(99999) });
    const result = effectiveStartBlock(pool, BigInt(100000));
    expect(result.startBlock).toBe(BigInt(99999));
    expect(result.skippedBlocks).toBe(BigInt(0));
  });
});
