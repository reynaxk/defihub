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
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { buildValidationMulticallCalls, CALLS_PER_CANDIDATE, isValidTokenDecimals, mergeCandidateReads, resolveValidationOutcome, validateDiscoveredPool, validateDiscoveredPoolsBatch } =
  await import("./validate");

// mockMulticall is shared module-wide (real production code path calls
// withResilientClient once per multicall - this mock stands in for that
// single call site) - reset its call history before every test so a
// toHaveBeenCalledTimes assertion in one test is never polluted by calls
// made in a previous test in this same file.
beforeEach(() => {
  mockMulticall.mockReset();
});

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

// Matches decodeCandidateReadAt's own (deliberately loose) parameter type
// in validate.ts - a mocked multicall response only ever needs `status`
// and `result`, never viem's full per-item error/gas-used shape.
type MockMulticallResult = { status: "success" | "failure"; result?: unknown };

function successfulMulticallResults(): MockMulticallResult[] {
  return [
    { status: "success", result: CANDIDATE.token0 },
    { status: "success", result: CANDIDATE.token1 },
    { status: "success", result: DEPLOYMENT.factoryAddress },
    { status: "success", result: [BigInt(1), BigInt(1), 0] },
    { status: "success", result: 18 },
    { status: "success", result: 18 },
    { status: "success", result: "TOK0" },
    { status: "success", result: "WBNB" },
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

describe("validateDiscoveredPoolsBatch - Phase 5.10: one multicall for a whole page, not one per candidate", () => {
  function candidateAt(index: number): DecodedPairCreated {
    return { ...CANDIDATE, poolAddress: `0x${index.toString().padStart(40, "0")}`, logIndex: CANDIDATE.logIndex + index };
  }

  it("REGRESSION: validating 5 candidates makes exactly ONE multicall call, not 5 - the whole page batched into one RPC round-trip", async () => {
    const candidates = [0, 1, 2, 3, 4].map(candidateAt);
    mockMulticall.mockImplementation(async () => candidates.flatMap(() => successfulMulticallResults()));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const outcomes = await validateDiscoveredPoolsBatch(DEPLOYMENT, candidates, readBlockHash, new Map());

    expect(mockMulticall).toHaveBeenCalledTimes(1);
    const callArgs = mockMulticall.mock.calls[0][0] as { contracts: unknown[] };
    expect(callArgs.contracts).toHaveLength(candidates.length * CALLS_PER_CANDIDATE);
    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) expect(outcome.status).toBe("accepted");
  });

  it("resolves each candidate's own outcome independently from its own slice of the batched multicall results - a rejected candidate does not affect its neighbors", async () => {
    const candidates = [candidateAt(0), candidateAt(1), candidateAt(2)];
    // Candidate 1 (the middle one) gets a mismatched onchainFactory in its
    // own slice - every other candidate's slice is untouched and must
    // still resolve to "accepted".
    const combined = [...successfulMulticallResults(), ...successfulMulticallResults(), ...successfulMulticallResults()];
    combined[1 * CALLS_PER_CANDIDATE + 2] = { status: "success" as const, result: "0x000000000000000000000000000000000bAd0" };
    mockMulticall.mockResolvedValue(combined);
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const outcomes = await validateDiscoveredPoolsBatch(DEPLOYMENT, candidates, readBlockHash, new Map());

    expect(outcomes[0].status).toBe("accepted");
    expect(outcomes[1].status).toBe("rejected");
    expect((outcomes[1] as { reason: string }).reason).toContain("does not match the configured factory");
    expect(outcomes[2].status).toBe("accepted");
  });

  it("a whole-batch multicall failure returns 'retry' for EVERY candidate in the page, never 'rejected'", async () => {
    mockMulticall.mockRejectedValue(new Error("provider unavailable"));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);
    const candidates = [candidateAt(0), candidateAt(1), candidateAt(2)];

    const outcomes = await validateDiscoveredPoolsBatch(DEPLOYMENT, candidates, readBlockHash, new Map());

    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) expect(outcome.status).toBe("retry");
  });

  it("an empty candidate list makes zero RPC calls and returns an empty array", async () => {
    mockMulticall.mockClear();
    const readBlockHash = vi.fn();
    const outcomes = await validateDiscoveredPoolsBatch(DEPLOYMENT, [], readBlockHash, new Map());
    expect(outcomes).toEqual([]);
    expect(mockMulticall).not.toHaveBeenCalled();
    expect(readBlockHash).not.toHaveBeenCalled();
  });

  it("still dedupes canonical-block-hash reads across the batch via the shared cache, exactly like the single-candidate path", async () => {
    // Both candidates share the exact same (blockNumber, blockHash).
    const candidates = [candidateAt(0), { ...candidateAt(1), blockNumber: CANDIDATE.blockNumber, blockHash: CANDIDATE.blockHash }];
    mockMulticall.mockImplementation(async () => candidates.flatMap(() => successfulMulticallResults()));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    await validateDiscoveredPoolsBatch(DEPLOYMENT, candidates, readBlockHash, new Map());

    expect(readBlockHash).toHaveBeenCalledTimes(1);
  });

  it("validateDiscoveredPool (single-candidate) delegates to validateDiscoveredPoolsBatch and produces an identical outcome to calling the batch function with a one-element array", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const single = await validateDiscoveredPool(DEPLOYMENT, CANDIDATE, readBlockHash);
    const [batched] = await validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash);

    expect(single).toEqual(batched);
  });
});

describe("validateDiscoveredPoolsBatch - Phase 5.11: bounded retry for a per-sub-call multicall failure", () => {
  function candidateAt(index: number): DecodedPairCreated {
    return { ...CANDIDATE, poolAddress: `0x${index.toString().padStart(40, "0")}`, logIndex: CANDIDATE.logIndex + index };
  }

  // A multicall response with the factory() sub-call (index 2) reporting
  // "failure" within an otherwise-successful multicall - the exact shape
  // live-observed against a real, freshly-discovered PancakeSwap V2 pool
  // whose factory() call succeeded moments later when queried directly
  // (both through the same RPC endpoint and cross-checked through a
  // completely different, independent provider) - see this fix's own
  // module comment in validate.ts.
  function incompleteMulticallResults(): MockMulticallResult[] {
    const results = successfulMulticallResults();
    results[2] = { status: "failure" };
    return results;
  }

  it("REGRESSION: a candidate whose factory() read fails on the first multicall but succeeds on retry is accepted, never falsely rejected", async () => {
    mockMulticall.mockResolvedValueOnce(incompleteMulticallResults()).mockResolvedValueOnce(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("accepted");
  });

  it("still rejects a candidate whose required-field reads fail consistently across the whole retry budget - a genuinely malformed contract is not retried forever", async () => {
    mockMulticall.mockResolvedValue(incompleteMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    // 1 initial attempt + MAX_DECODE_RETRY_ATTEMPTS (3) retries = 4 total.
    expect(mockMulticall).toHaveBeenCalledTimes(4);
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("factory()");
  });

  it("only re-queries the SPECIFIC candidates with an incomplete decode on retry, not the whole page", async () => {
    const candidates = [candidateAt(0), candidateAt(1), candidateAt(2)];
    // Only candidate 1 (the middle one) has an incomplete first decode.
    const firstAttempt = [...successfulMulticallResults(), ...incompleteMulticallResults(), ...successfulMulticallResults()];
    mockMulticall.mockResolvedValueOnce(firstAttempt).mockResolvedValueOnce(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomesPromise = validateDiscoveredPoolsBatch(DEPLOYMENT, candidates, readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const outcomes = await outcomesPromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(2);
    // The retry's own multicall covers exactly ONE candidate's worth of
    // calls, not all three - proof the other two, already-complete
    // candidates were never re-queried.
    const retryCallArgs = mockMulticall.mock.calls[1][0] as { contracts: unknown[] };
    expect(retryCallArgs.contracts).toHaveLength(CALLS_PER_CANDIDATE);
    expect(outcomes.every((o) => o.status === "accepted")).toBe(true);
  });

  it("a retry-multicall transport failure stops the retry loop - the candidate keeps its original (incomplete) decode and is still correctly rejected, never stuck retrying", async () => {
    mockMulticall.mockResolvedValueOnce(incompleteMulticallResults()).mockRejectedValueOnce(new Error("provider unavailable"));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(2); // initial + the one failed retry attempt, then it gave up
    expect(outcome.status).toBe("rejected");
  });

  it("never retries a candidate whose ONLY incomplete field is the best-effort symbol() reads - symbols are never validated or retried on", async () => {
    const results = successfulMulticallResults();
    results[6] = { status: "failure" }; // token0Symbol
    results[7] = { status: "failure" }; // token1Symbol
    mockMulticall.mockResolvedValue(results);
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const [outcome] = await validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());

    expect(mockMulticall).toHaveBeenCalledTimes(1); // no retry attempted at all
    expect(outcome.status).toBe("accepted");
    if (outcome.status === "accepted") {
      expect(outcome.token0Symbol).toBeNull();
      expect(outcome.token1Symbol).toBeNull();
    }
  });
});

// PR #19 review round (CodeRabbit + manual review): retryIncompleteDecodes
// previously replaced a candidate's WHOLE decoded record with whatever the
// latest retry attempt produced - so a field that had already succeeded on
// an earlier attempt could be silently erased if that SAME field happened
// to fail on a later retry (every retry re-reads every pending field, it
// can't ask for "only the fields still missing"). mergeCandidateReads fixes
// this: a field's most recent SUCCESSFUL read wins, and a field is only
// ever "still incomplete" if it has NEVER succeeded across any attempt.
describe("mergeCandidateReads - PR #19: per-field monotonic merge across retry attempts", () => {
  it("attempt 1 has factory/token0/token1 but reserves fails; attempt 2 has reserves but a PREVIOUSLY-SUCCESSFUL field (token0) fails again -> the merged result retains every field that ever succeeded", () => {
    const attempt1 = decoded({ reservesCallSucceeded: false });
    const attempt2 = decoded({ onchainToken0: null, token0Decimals: undefined, token0Symbol: null }); // token0 (and its decimals/symbol) flake on this attempt; reserves now succeeds

    const merged = mergeCandidateReads(attempt1, attempt2);

    expect(merged).toEqual(
      decoded({
        reservesCallSucceeded: true, // taken from attempt2, the attempt that actually succeeded at it
        // token0 (address/decimals/symbol) preserved from attempt1 even
        // though attempt2's own read of it failed - this is the exact
        // erasure the old "replace wholesale" code was vulnerable to.
      }),
    );
  });

  it("attempt 1 has some successful fields; every later attempt is fully incomplete -> the attempt-1 successes remain in the final merged result", () => {
    const attempt1 = decoded({ reservesCallSucceeded: false });
    const allIncomplete: DecodedCandidateRead = {
      onchainToken0: null,
      onchainToken1: null,
      onchainFactory: null,
      reservesCallSucceeded: false,
      token0Decimals: undefined,
      token1Decimals: undefined,
      token0Symbol: null,
      token1Symbol: null,
    };

    let merged = attempt1;
    for (let i = 0; i < 3; i++) {
      merged = mergeCandidateReads(merged, allIncomplete);
    }

    // token0/token1/factory/decimals/symbols all came from attempt 1 and
    // were never re-confirmed - none of that is lost just because every
    // later attempt came back empty. Only reservesCallSucceeded, which
    // never succeeded on ANY attempt, correctly stays false.
    expect(merged).toEqual(decoded({ reservesCallSucceeded: false }));
  });

  it("a field that has never succeeded on any attempt stays unresolved (never fabricated as a fallback)", () => {
    const attempt1 = decoded({ onchainFactory: null });
    const attempt2 = decoded({ onchainFactory: null, onchainToken0: null });

    const merged = mergeCandidateReads(attempt1, attempt2);

    expect(merged.onchainFactory).toBeNull();
    expect(merged.onchainToken1).toBe(CANDIDATE.token1); // succeeded both times, still present
  });
});

describe("validateDiscoveredPoolsBatch - PR #19: end-to-end proof the retry loop uses the merged result, not the last attempt alone", () => {
  it("a field that succeeded on the initial multicall but fails again on the ONLY retry attempt still resolves to 'accepted', exiting the retry loop early instead of burning the whole budget", async () => {
    const initial = successfulMulticallResults();
    initial[3] = { status: "failure" }; // getReserves fails; token0/token1/factory all succeed

    const retry = successfulMulticallResults();
    retry[0] = { status: "failure" }; // token0 flakes on retry; reserves now succeeds

    mockMulticall.mockResolvedValueOnce(initial).mockResolvedValueOnce(retry);
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    // Without the merge fix, the retry's own token0 failure would have
    // wholesale-overwritten the initial attempt's token0 success, leaving
    // the candidate "still incomplete" and consuming the full 4-call
    // budget before an incorrect rejection. With the fix, the merge
    // recognizes every required field has now succeeded at least once and
    // stops after exactly one retry.
    expect(mockMulticall).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("accepted");
  });

  it("a transport-level failure DURING a retry never erases the previous attempt's successful fields - the candidate is rejected for the field that's genuinely still missing, not for one it had already confirmed", async () => {
    const initial = successfulMulticallResults();
    initial[0] = { status: "failure" }; // token0 fails; factory/token1/reserves all succeed on the initial read

    mockMulticall.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("provider unavailable"));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateDiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(2); // initial + the one failed retry attempt, then it gave up
    expect(outcome.status).toBe("rejected");
    // Rejected specifically for the still-missing token0/token1 read, NOT
    // "factory() read failed" - proof the initial attempt's genuine
    // factory() success was never erased by the aborted retry.
    expect((outcome as { reason: string }).reason).toContain("token0()/token1() read failed");
  });
});
