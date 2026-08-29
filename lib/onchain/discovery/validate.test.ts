// Pure unit tests for the discovery validation decision - no RPC, no DB.
// Uses the same real, live-captured PancakeSwap pool/factory addresses as
// scan.test.ts (real pool 0x408323DB..., real factory
// 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73, both independently confirmed
// live: pool.factory() returns exactly this factory address, pool.token0()/
// token1() return exactly the event's own claimed tokens).
import { describe, expect, it } from "vitest";
import type { FactoryDeployment } from "./config";
import type { DecodedPairCreated } from "./scan";
import { CALLS_PER_CANDIDATE, buildValidationMulticallCalls, isValidTokenDecimals, resolveValidationOutcome, type DecodedCandidateRead } from "./validate";

const DEPLOYMENT: FactoryDeployment = {
  key: "pancakeswap-v2-bnb-chain",
  chainSlug: "bnb-chain",
  protocolDefillamaSlug: "pancakeswap-amm",
  dexKind: "uniswap-v2",
  factoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  feeBps: 25,
  startBlock: BigInt(1),
};

const CANDIDATE: DecodedPairCreated = {
  token0: "0x440D030c33f19c5fFf532EE0270393917B147777",
  token1: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  poolAddress: "0x408323DB31aD486968920F7C32330e7E09058678",
  blockNumber: BigInt(118818170),
  blockHash: "0x90a6cfe23924c44b43399db1a245d85684083487069393f0c402ec809005a2eb",
  transactionHash: "0x998396b66ce35a99dd66b02e0a5df729bafbd8cb49f14417cabc7b76f75eafa3",
  logIndex: 155,
};

function decoded(overrides: Partial<DecodedCandidateRead> = {}): DecodedCandidateRead {
  return {
    onchainToken0: CANDIDATE.token0 as `0x${string}`,
    onchainToken1: CANDIDATE.token1 as `0x${string}`,
    onchainFactory: DEPLOYMENT.factoryAddress as `0x${string}`,
    reservesCallSucceeded: true,
    token0Decimals: 18,
    token1Decimals: 18,
    token0Symbol: "TOK0",
    token1Symbol: "WBNB",
    ...overrides,
  };
}

describe("isValidTokenDecimals", () => {
  it("accepts a normal token decimals value", () => {
    expect(isValidTokenDecimals(18)).toBe(true);
    expect(isValidTokenDecimals(6)).toBe(true);
    expect(isValidTokenDecimals(0)).toBe(true);
  });

  it("accepts exactly CALCULATION_SCALE (the upper boundary, inclusive)", () => {
    expect(isValidTokenDecimals(30)).toBe(true);
  });

  it("rejects a value one above CALCULATION_SCALE", () => {
    expect(isValidTokenDecimals(31)).toBe(false);
  });

  it("rejects negative decimals", () => {
    expect(isValidTokenDecimals(-1)).toBe(false);
  });

  it("rejects a fractional value", () => {
    expect(isValidTokenDecimals(6.5)).toBe(false);
  });

  it("rejects a non-number (malformed RPC result)", () => {
    expect(isValidTokenDecimals("18")).toBe(false);
    expect(isValidTokenDecimals(undefined)).toBe(false);
    expect(isValidTokenDecimals(null)).toBe(false);
    expect(isValidTokenDecimals(BigInt(18))).toBe(false);
  });

  it("rejects NaN/Infinity", () => {
    expect(isValidTokenDecimals(NaN)).toBe(false);
    expect(isValidTokenDecimals(Infinity)).toBe(false);
  });
});

describe("buildValidationMulticallCalls", () => {
  it("emits exactly CALLS_PER_CANDIDATE calls per candidate, in the documented order", () => {
    const calls = buildValidationMulticallCalls([CANDIDATE]);
    expect(calls).toHaveLength(CALLS_PER_CANDIDATE);
    expect(calls.map((c) => c.functionName)).toEqual(["token0", "token1", "factory", "getReserves", "decimals", "decimals", "symbol", "symbol"]);
    expect(calls[0].address).toBe(CANDIDATE.poolAddress);
    expect(calls[4].address).toBe(CANDIDATE.token0);
    expect(calls[5].address).toBe(CANDIDATE.token1);
    expect(calls[6].address).toBe(CANDIDATE.token0);
    expect(calls[7].address).toBe(CANDIDATE.token1);
  });

  it("returns an empty array for an empty candidate list, never throwing", () => {
    expect(buildValidationMulticallCalls([])).toEqual([]);
  });
});

describe("resolveValidationOutcome", () => {
  it("accepts a candidate that passes every check - canonical, matching factory, matching tokens, valid interface, valid decimals", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "confirmed");
    expect(outcome).toEqual({ accepted: true, token0Decimals: 18, token1Decimals: 18, token0Symbol: "TOK0", token1Symbol: "WBNB" });
  });

  it("accepts a candidate even when BOTH symbol() reads fail - symbol is best-effort, never a rejection reason", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Symbol: null, token1Symbol: null }), "confirmed");
    expect(outcome).toEqual({ accepted: true, token0Decimals: 18, token1Decimals: 18, token0Symbol: null, token1Symbol: null });
  });

  it("REORG: rejects a candidate whose creation block is no longer canonical - never promoted merely because the event existed temporarily", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "reorged");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("no longer canonical");
  });

  it("rejects (never accepts) when the canonical check itself could not be determined - unknown is not treated as license to proceed", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "unknown");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("will retry");
  });

  it("WRONG FACTORY: rejects a pool-like contract whose factory() does not match the configured deployment - never trusted merely because a PairCreated-shaped event named it", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: "0x0000000000000000000000000000000000dEaD" }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("does not match the configured factory");
  });

  it("rejects when factory() itself fails to read", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: null }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("factory() read failed");
  });

  it("MALFORMED: rejects when the pool's own token0()/token1() disagree with the PairCreated event's claimed tokens", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainToken0: "0x0000000000000000000000000000000000dEaD" }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("do not match the PairCreated event");
  });

  it("rejects when token0()/token1() fail to read", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainToken0: null }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("token0()/token1() read failed");
  });

  it("MALFORMED: rejects when getReserves() fails - not a well-formed V2 pair contract", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ reservesCallSucceeded: false }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("getReserves() call failed");
  });

  it("MALFORMED: rejects when token0 decimals() is malformed", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Decimals: -1 }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("token0");
  });

  it("MALFORMED: rejects when token1 decimals() is malformed", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token1Decimals: 999 }), "confirmed");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("token1");
  });

  it("checks canonical status BEFORE any other check - a reorged candidate is rejected for that reason even if every other field would otherwise pass", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: null, onchainToken0: null }), "reorged");
    expect(outcome.accepted).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("no longer canonical");
  });
});
