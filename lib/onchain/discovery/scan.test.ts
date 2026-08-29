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
import { decodePairCreatedLog, PAIR_CREATED_EVENT_SIGNATURE } from "./scan";

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
