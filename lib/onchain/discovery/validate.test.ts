// Pure unit tests for the discovery validation decision - no live RPC, no
// DB. Uses the same real, live-captured PancakeSwap pool/factory addresses
// as scan.test.ts (real pool 0x408323DB..., real factory
// 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73, both independently confirmed
// live: pool.factory() returns exactly this factory address, pool.token0()/
// token1() return exactly the event's own claimed tokens).
//
// withResilientClient is mocked module-wide (same pattern
// lib/indexing/events.test.ts already established) so the
// validateDiscoveredPool-level tests below (canonical-check caching,
// transient-failure retryability) are genuinely RPC-free and deterministic
// - the multicall itself is never what those tests are actually checking.
import { describe, expect, it, vi } from "vitest";
import type { ReorgCheckResult } from "@/lib/onchain/reorg";
import { CALCULATION_SCALE } from "@/lib/onchain/volume/math";
import type { FactoryDeployment } from "./config";
import type { DecodedPairCreated } from "./scan";
import type { DecodedCandidateRead } from "./validate";

const mockMulticall = vi.fn();
vi.mock("@/lib/chains/rpc-resilient-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/chains/rpc-resilient-client")>();
  return {
    ...actual,
    withResilientClient: (_chainSlug: string, fn: (client: { multicall: typeof mockMulticall }) => unknown) => fn({ multicall: mockMulticall }),
  };
});

const { buildValidationMulticallCalls, CALLS_PER_CANDIDATE, isValidTokenDecimals, resolveValidationOutcome, validateDiscoveredPool } = await import("./validate");

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
    expect(isValidTokenDecimals(CALCULATION_SCALE)).toBe(true);
  });

  it("rejects a value one above CALCULATION_SCALE", () => {
    expect(isValidTokenDecimals(CALCULATION_SCALE + 1)).toBe(false);
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
    expect(outcome).toEqual({ status: "accepted", token0Decimals: 18, token1Decimals: 18, token0Symbol: "TOK0", token1Symbol: "WBNB" });
  });

  it("accepts a candidate even when BOTH symbol() reads fail - symbol is best-effort, never a rejection reason", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Symbol: null, token1Symbol: null }), "confirmed");
    expect(outcome).toEqual({ status: "accepted", token0Decimals: 18, token1Decimals: 18, token0Symbol: null, token1Symbol: null });
  });

  it("REORG: rejects (terminal) a candidate whose creation block is no longer canonical - never promoted merely because the event existed temporarily", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "reorged");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("no longer canonical");
  });

  it("RETRYABLE: never rejects (terminal) when the canonical check itself could not be determined - unknown means retry, not reject", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "unknown");
    expect(outcome.status).toBe("retry");
    expect((outcome as { reason: string }).reason).toContain("will retry");
  });

  it("WRONG FACTORY: rejects a pool-like contract whose factory() does not match the configured deployment - never trusted merely because a PairCreated-shaped event named it", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: "0x0000000000000000000000000000000000dEaD" }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("does not match the configured factory");
  });

  it("rejects when factory() itself fails to read", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: null }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("factory() read failed");
  });

  it("MALFORMED: rejects when the pool's own token0()/token1() disagree with the PairCreated event's claimed tokens", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainToken0: "0x0000000000000000000000000000000000dEaD" }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("do not match the PairCreated event");
  });

  it("rejects when token0()/token1() fail to read", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainToken0: null }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("token0()/token1() read failed");
  });

  it("MALFORMED: rejects when getReserves() fails - not a well-formed V2 pair contract", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ reservesCallSucceeded: false }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("getReserves() call failed");
  });

  it("MALFORMED: rejects when token0 decimals() is malformed", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Decimals: -1 }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("token0");
  });

  it("MALFORMED: rejects when token1 decimals() is malformed", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token1Decimals: 999 }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("token1");
  });

  it("checks canonical status BEFORE any other check - a reorged candidate is rejected for that reason even if every other field would otherwise pass", () => {
    const outcome = resolveValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: null, onchainToken0: null }), "reorged");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("no longer canonical");
  });
});

function successfulMulticallResults() {
  return [
    { status: "success" as const, result: CANDIDATE.token0 },
    { status: "success" as const, result: CANDIDATE.token1 },
    { status: "success" as const, result: DEPLOYMENT.factoryAddress },
    { status: "success" as const, result: [BigInt(1), BigInt(1), 0] },
    { status: "success" as const, result: 18 },
    { status: "success" as const, result: 18 },
    { status: "success" as const, result: "TOK0" },
    { status: "success" as const, result: "WBNB" },
  ];
}

describe("validateDiscoveredPool - canonical-check caching", () => {
  it("shares one canonical-block-hash read across two candidates with the same (blockNumber, blockHash), when given a shared cache", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);
    const cache = new Map<string, Promise<ReorgCheckResult>>();

    const candidateB: DecodedPairCreated = { ...CANDIDATE, poolAddress: "0x0000000000000000000000000000000000cAfE", logIndex: CANDIDATE.logIndex + 1 };

    // Both candidates share the SAME creation block/hash (the real,
    // observed live pattern - multiple pairs created in one block) but
    // are otherwise distinct pools.
    await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash, cache);
    await validateDiscoveredPool(DEPLOYMENT, candidateB, readBlockHash, cache);

    expect(readBlockHash).toHaveBeenCalledTimes(1);
  });

  it("does NOT share a cached result between two candidates at the same block number but DIFFERENT block hashes", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);
    const cache = new Map<string, Promise<ReorgCheckResult>>();

    const candidateDifferentHash: DecodedPairCreated = { ...CANDIDATE, blockHash: "0x" + "99".repeat(32), poolAddress: "0x0000000000000000000000000000000000cAfE" };

    await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash, cache);
    await validateDiscoveredPool(DEPLOYMENT, candidateDifferentHash, readBlockHash, cache);

    // Two distinct cache keys (different blockHash) - two real reads, even
    // though both share the same blockNumber.
    expect(readBlockHash).toHaveBeenCalledTimes(2);
  });

  it("without a cache (the default), makes an independent read per call - existing single-candidate behavior is unchanged", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash);
    await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash);

    expect(readBlockHash).toHaveBeenCalledTimes(2);
  });
});

describe("validateDiscoveredPool - transient failures are retryable, never terminal", () => {
  it("REGRESSION: a whole-multicall RPC failure returns 'retry', never 'rejected' - a transient RPC hiccup must never permanently blacklist a real, valid pool", async () => {
    mockMulticall.mockRejectedValue(new Error("connection reset"));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash); // canonical check succeeds; the multicall is what fails
    const outcome = await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash);
    expect(outcome.status).toBe("retry");
  });

  it("REGRESSION: an unresolvable canonical-block check (readBlockHash itself fails) returns 'retry', never 'rejected'", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockRejectedValue(new Error("RPC down"));
    const outcome = await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash);
    expect(outcome.status).toBe("retry");
  });
});
