// Pure unit tests for decodePairCreatedLog - no RPC, no DB. Uses a REAL,
// live-captured PairCreated event from the real PancakeSwap V2 Factory
// (block 118,818,170), fetched directly via eth_getLogs and hand-decoded
// with viem's decodeEventLog during this phase's own development - not a
// synthesized fixture. Independently confirmed live against the discovered
// pool itself: token0()/token1() on the real pool contract
// (0x408323DB31aD486968920F7C32330e7E09058678) return the exact same two
// addresses this event claims, and factory() on that same pool returns the
// real, canonical PancakeSwap V2 Factory address - see validate.test.ts for
// the matching validation-side fixture.
import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import { decodePairCreatedLog, decodePoolCreatedLog, PAIR_CREATED_EVENT_SIGNATURE, POOL_CREATED_EVENT_SIGNATURE } from "./scan";

const REAL_PAIR_CREATED_LOG_RAW = {
  address: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
  blockNumber: BigInt(118818170),
  blockHash: "0x90a6cfe23924c44b43399db1a245d85684083487069393f0c402ec809005a2eb",
  transactionHash: "0x998396b66ce35a99dd66b02e0a5df729bafbd8cb49f14417cabc7b76f75eafa3",
  logIndex: 155,
  args: {
    token0: "0x440D030c33f19c5fFf532EE0270393917B147777",
    token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    pair: "0x408323DB31aD486968920F7C32330e7E09058678",
  },
};
const REAL_PAIR_CREATED_LOG = REAL_PAIR_CREATED_LOG_RAW as unknown as Log;

describe("PAIR_CREATED_EVENT_SIGNATURE", () => {
  it("matches the real, canonical Uniswap V2 Factory event topic0 (verified live against both configured factories)", () => {
    // "PairCreated(address,address,address,uint256)" -> keccak256 topic0 -
    // naming the trailing parameter does not change the topic0 hash (only
    // types are hashed, not parameter names), independently confirmed live
    // via eth_getLogs against the real PancakeSwap V2 Factory during this
    // phase's own development.
    expect(PAIR_CREATED_EVENT_SIGNATURE).toBe("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)");
  });

  it("REGRESSION: every parameter is named, so viem's decodeEventLog returns a named args object rather than a positional array - real bug caught live: an unnamed trailing parameter silently made every real log undecodable", async () => {
    const { parseAbiItem } = await import("viem");
    const abiItem = parseAbiItem(PAIR_CREATED_EVENT_SIGNATURE);
    if (abiItem.type !== "event") throw new Error("expected an event ABI item");
    expect(abiItem.inputs.every((input) => Boolean(input.name))).toBe(true);
  });
});

describe("decodePairCreatedLog", () => {
  it("decodes a real, live-captured PairCreated event exactly", () => {
    const decoded = decodePairCreatedLog(REAL_PAIR_CREATED_LOG);
    expect(decoded).toEqual({
      token0: "0x440D030c33f19c5fFf532EE0270393917B147777",
      token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      poolAddress: "0x408323DB31aD486968920F7C32330e7E09058678",
      blockNumber: BigInt(118818170),
      blockHash: "0x90a6cfe23924c44b43399db1a245d85684083487069393f0c402ec809005a2eb",
      transactionHash: "0x998396b66ce35a99dd66b02e0a5df729bafbd8cb49f14417cabc7b76f75eafa3",
      logIndex: 155,
    });
  });

  it("returns null when block identity fields are missing (a pending/unmined log)", () => {
    const pending = { ...REAL_PAIR_CREATED_LOG_RAW, blockNumber: null, blockHash: null, transactionHash: null, logIndex: null } as unknown as Log;
    expect(decodePairCreatedLog(pending)).toBeNull();
  });

  it("returns null when decoded args are entirely missing", () => {
    const noArgs = { ...REAL_PAIR_CREATED_LOG_RAW, args: undefined } as unknown as Log;
    expect(decodePairCreatedLog(noArgs)).toBeNull();
  });

  it("returns null when a field has the wrong type (malformed/non-string decode) - never coerced or fabricated", () => {
    const malformed = { ...REAL_PAIR_CREATED_LOG_RAW, args: { ...REAL_PAIR_CREATED_LOG_RAW.args, pair: BigInt(123) } } as unknown as Log;
    expect(decodePairCreatedLog(malformed)).toBeNull();
  });

  it("returns null when only token0 is present but token1/pair are missing (partial/wrong-shaped event)", () => {
    const partial = { ...REAL_PAIR_CREATED_LOG_RAW, args: { token0: REAL_PAIR_CREATED_LOG_RAW.args.token0 } } as unknown as Log;
    expect(decodePairCreatedLog(partial)).toBeNull();
  });
});

// Phase 5.11's V3 discovery expansion. Real, live-captured PoolCreated
// event from the real, canonical Uniswap V3 Factory
// (0x1F98431c8aD98523631AE4a59f267346ea31F984, block 25,526,276) - fetched
// via viem's own getLogs (which decodes `args` itself, avoiding any manual
// hex-parsing transcription risk) during this phase's own development, not
// a synthesized fixture. A real, deployed 0.01% (fee=100) USDC-line pool
// (token1 is the real, canonical WETH address).
const REAL_POOL_CREATED_LOG_RAW = {
  address: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  blockNumber: BigInt(25526276),
  blockHash: "0x0cf17e8994002a3c39e9dfe246ea5b66852a6be3b9108f7c8d62c2b0a4a30fc7",
  transactionHash: "0x41318a7cf9f0cd86f30c3a7d5c0ccdef9498edb6e7220d616e94d654b0d65617",
  logIndex: 288,
  args: {
    token0: "0x53857faBea03534c3cda9B39Baf975Bf7D4C3366",
    token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    fee: 100,
    tickSpacing: 1,
    pool: "0x03212074574DB7DEefA2f4e9194A96C1Af923aA6",
  },
};
const REAL_POOL_CREATED_LOG = REAL_POOL_CREATED_LOG_RAW as unknown as Log;

describe("POOL_CREATED_EVENT_SIGNATURE", () => {
  it("matches the real, canonical Uniswap V3 Factory event topic0 (verified live)", () => {
    expect(POOL_CREATED_EVENT_SIGNATURE).toBe("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
  });

  it("every parameter is named, so viem's decodeEventLog returns a named args object rather than a positional array - the same class of mistake PAIR_CREATED_EVENT_SIGNATURE's own regression test already guards against", async () => {
    const { parseAbiItem } = await import("viem");
    const abiItem = parseAbiItem(POOL_CREATED_EVENT_SIGNATURE);
    if (abiItem.type !== "event") throw new Error("expected an event ABI item");
    expect(abiItem.inputs.every((input) => Boolean(input.name))).toBe(true);
  });
});

describe("decodePoolCreatedLog", () => {
  it("decodes a real, live-captured PoolCreated event exactly", () => {
    const decoded = decodePoolCreatedLog(REAL_POOL_CREATED_LOG);
    expect(decoded).toEqual({
      token0: "0x53857faBea03534c3cda9B39Baf975Bf7D4C3366",
      token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      feeTier: 100,
      poolAddress: "0x03212074574DB7DEefA2f4e9194A96C1Af923aA6",
      blockNumber: BigInt(25526276),
      blockHash: "0x0cf17e8994002a3c39e9dfe246ea5b66852a6be3b9108f7c8d62c2b0a4a30fc7",
      transactionHash: "0x41318a7cf9f0cd86f30c3a7d5c0ccdef9498edb6e7220d616e94d654b0d65617",
      logIndex: 288,
    });
  });

  it("returns null when block identity fields are missing (a pending/unmined log)", () => {
    const pending = { ...REAL_POOL_CREATED_LOG_RAW, blockNumber: null, blockHash: null, transactionHash: null, logIndex: null } as unknown as Log;
    expect(decodePoolCreatedLog(pending)).toBeNull();
  });

  it("returns null when decoded args are entirely missing", () => {
    const noArgs = { ...REAL_POOL_CREATED_LOG_RAW, args: undefined } as unknown as Log;
    expect(decodePoolCreatedLog(noArgs)).toBeNull();
  });

  it("returns null when fee is not a number (malformed/non-standard decode) - never coerced or fabricated", () => {
    const malformed = { ...REAL_POOL_CREATED_LOG_RAW, args: { ...REAL_POOL_CREATED_LOG_RAW.args, fee: "100" } } as unknown as Log;
    expect(decodePoolCreatedLog(malformed)).toBeNull();
  });

  it("returns null when fee is a non-integer number", () => {
    const malformed = { ...REAL_POOL_CREATED_LOG_RAW, args: { ...REAL_POOL_CREATED_LOG_RAW.args, fee: 100.5 } } as unknown as Log;
    expect(decodePoolCreatedLog(malformed)).toBeNull();
  });

  it("returns null when only some fields are present (partial/wrong-shaped event)", () => {
    const partial = { ...REAL_POOL_CREATED_LOG_RAW, args: { token0: REAL_POOL_CREATED_LOG_RAW.args.token0 } } as unknown as Log;
    expect(decodePoolCreatedLog(partial)).toBeNull();
  });

  it("never mixes up with V2's PairCreated shape - a V2-shaped args object (token0/token1/pair, no fee) decodes as null", () => {
    const v2Shaped = { ...REAL_POOL_CREATED_LOG_RAW, args: { token0: "0xaaa", token1: "0xbbb", pair: "0xccc" } } as unknown as Log;
    expect(decodePoolCreatedLog(v2Shaped)).toBeNull();
  });
});
