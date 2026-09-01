// Pure unit tests for the V3 discovery validation decision - no live RPC,
// no DB. Uses the real, live-captured Uniswap V3 pool/factory addresses
// from scan.test.ts (real pool 0x03212074..., real factory
// 0x1F98431c8aD98523631AE4a59f267346ea31F984, both independently verified
// elsewhere in this app - see lib/onchain/config.ts's own
// uniswap-v3-eth-usdc-weth-005 entry for the identical factory address's
// original verification).
//
// withResilientClient is mocked module-wide, same pattern validate.test.ts
// (V2) already established.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReorgCheckResult } from "@/lib/onchain/reorg";
import type { UniswapV3FactoryDeployment } from "./config";
import type { DecodedPoolCreated } from "./scan";
import type { DecodedV3CandidateRead } from "./validate-v3";

const mockMulticall = vi.fn();
vi.mock("@/lib/chains/rpc-resilient-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/chains/rpc-resilient-client")>();
  return {
    ...actual,
    withResilientClient: (_chainSlug: string, fn: (client: { multicall: typeof mockMulticall }) => unknown) => fn({ multicall: mockMulticall }),
  };
});

const { buildV3ValidationMulticallCalls, CALLS_PER_V3_CANDIDATE, resolveV3ValidationOutcome, validateV3DiscoveredPoolsBatch } = await import("./validate-v3");

beforeEach(() => {
  mockMulticall.mockReset();
});

const DEPLOYMENT: UniswapV3FactoryDeployment = {
  key: "uniswap-v3-ethereum",
  chainSlug: "ethereum",
  protocolDefillamaSlug: "uniswap-v3",
  dexKind: "uniswap-v3",
  factoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  startBlock: BigInt(1),
};

const CANDIDATE: DecodedPoolCreated = {
  token0: "0x53857faBea03534c3cda9B39Baf975Bf7D4C3366",
  token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  feeTier: 100,
  poolAddress: "0x03212074574DB7DEefA2f4e9194A96C1Af923aA6",
  blockNumber: BigInt(25526276),
  blockHash: "0x0cf17e8994002a3c39e9dfe246ea5b66852a6be3b9108f7c8d62c2b0a4a30fc7",
  transactionHash: "0x41318a7cf9f0cd86f30c3a7d5c0ccdef9498edb6e7220d616e94d654b0d65617",
  logIndex: 288,
};

type MockMulticallResult = { status: "success" | "failure"; result?: unknown };

function decoded(overrides: Partial<DecodedV3CandidateRead> = {}): DecodedV3CandidateRead {
  return {
    onchainToken0: CANDIDATE.token0 as `0x${string}`,
    onchainToken1: CANDIDATE.token1 as `0x${string}`,
    onchainFactory: DEPLOYMENT.factoryAddress as `0x${string}`,
    onchainFeeTier: CANDIDATE.feeTier,
    liquidityCallSucceeded: true,
    token0Decimals: 18,
    token1Decimals: 6,
    token0Symbol: "WETH",
    token1Symbol: "TOK0",
    ...overrides,
  };
}

function successfulMulticallResults(): MockMulticallResult[] {
  return [
    { status: "success", result: CANDIDATE.token0 },
    { status: "success", result: CANDIDATE.token1 },
    { status: "success", result: DEPLOYMENT.factoryAddress },
    { status: "success", result: CANDIDATE.feeTier },
    { status: "success", result: BigInt(12345) },
    { status: "success", result: 18 },
    { status: "success", result: 6 },
    { status: "success", result: "WETH" },
    { status: "success", result: "TOK0" },
  ];
}

describe("buildV3ValidationMulticallCalls", () => {
  it("emits exactly CALLS_PER_V3_CANDIDATE calls per candidate, in the documented order", () => {
    const calls = buildV3ValidationMulticallCalls([CANDIDATE]);
    expect(calls).toHaveLength(CALLS_PER_V3_CANDIDATE);
    expect(calls.map((c) => c.functionName)).toEqual(["token0", "token1", "factory", "fee", "liquidity", "decimals", "decimals", "symbol", "symbol"]);
  });
});

describe("resolveV3ValidationOutcome", () => {
  it("accepts a candidate that passes every check - canonical, matching factory, matching tokens, matching fee, valid interface, valid decimals", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "confirmed");
    expect(outcome).toEqual({ status: "accepted", token0Decimals: 18, token1Decimals: 6, token0Symbol: "WETH", token1Symbol: "TOK0" });
  });

  it("REORG: rejects (terminal) a candidate whose creation block is no longer canonical", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "reorged");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("no longer canonical");
  });

  it("RETRYABLE: an unresolvable canonical check means retry, never a terminal rejection", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded(), "unknown");
    expect(outcome.status).toBe("retry");
  });

  it("WRONG FACTORY: rejects a pool whose factory() does not match the configured deployment", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: "0x000000000000000000000000000000000000dead" }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("does not match the configured factory");
  });

  it("rejects when factory() itself fails to read", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFactory: null }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("factory() read failed");
  });

  it("MALFORMED: rejects when the pool's own token0()/token1() disagree with the PoolCreated event's claimed tokens", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainToken0: "0x000000000000000000000000000000000000dead" }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("do not match the PoolCreated event");
  });

  it("V3-SPECIFIC: rejects when the pool's own fee() disagrees with the PoolCreated event's claimed fee tier - never trusted from the event alone", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFeeTier: 3000 }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("does not match the PoolCreated event's own claimed fee tier");
  });

  it("rejects when fee() itself fails to read", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ onchainFeeTier: null }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("fee() read failed");
  });

  it("MALFORMED: rejects when liquidity() fails - not a well-formed V3 pool contract", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ liquidityCallSucceeded: false }), "confirmed");
    expect(outcome.status).toBe("rejected");
    expect((outcome as { reason: string }).reason).toContain("liquidity() call failed");
  });

  it("MALFORMED: rejects when token0 decimals() is malformed", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Decimals: -1 }), "confirmed");
    expect(outcome.status).toBe("rejected");
  });

  it("accepts a candidate even when BOTH symbol() reads fail - symbol is best-effort, never a rejection reason", () => {
    const outcome = resolveV3ValidationOutcome(DEPLOYMENT, CANDIDATE, decoded({ token0Symbol: null, token1Symbol: null }), "confirmed");
    expect(outcome.status).toBe("accepted");
  });
});

describe("validateV3DiscoveredPoolsBatch - one multicall for a whole page", () => {
  it("validates a real page of candidates in exactly ONE multicall round-trip", async () => {
    mockMulticall.mockResolvedValue(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const [outcome] = await validateV3DiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());

    expect(mockMulticall).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("accepted");
  });

  it("an empty candidate list makes zero RPC calls", async () => {
    const readBlockHash = vi.fn();
    const outcomes = await validateV3DiscoveredPoolsBatch(DEPLOYMENT, [], readBlockHash, new Map());
    expect(outcomes).toEqual([]);
    expect(mockMulticall).not.toHaveBeenCalled();
  });

  it("REGRESSION: a whole-multicall RPC failure returns 'retry' for every candidate, never 'rejected'", async () => {
    mockMulticall.mockRejectedValue(new Error("provider unavailable"));
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    const [outcome] = await validateV3DiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());

    expect(outcome.status).toBe("retry");
  });

  it("REGRESSION: a per-sub-call fee() failure that succeeds on retry is accepted, never falsely rejected - the same live-confirmed false-rejection class validate.ts's own fix addresses", async () => {
    const incomplete = successfulMulticallResults();
    incomplete[3] = { status: "failure" };
    mockMulticall.mockResolvedValueOnce(incomplete).mockResolvedValueOnce(successfulMulticallResults());
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateV3DiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("accepted");
  });

  it("still rejects a candidate whose fee() read fails consistently across the whole retry budget", async () => {
    const incomplete = successfulMulticallResults();
    incomplete[3] = { status: "failure" };
    mockMulticall.mockResolvedValue(incomplete);
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);

    vi.useFakeTimers();
    const outcomePromise = validateV3DiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE], readBlockHash, new Map());
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;
    vi.useRealTimers();

    expect(mockMulticall).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(outcome.status).toBe("rejected");
  });

  it("caches a canonical-block-hash read across two candidates sharing the same (blockNumber, blockHash)", async () => {
    mockMulticall.mockResolvedValue([...successfulMulticallResults(), ...successfulMulticallResults()]);
    const readBlockHash = vi.fn().mockResolvedValue(CANDIDATE.blockHash);
    const candidateB: DecodedPoolCreated = { ...CANDIDATE, poolAddress: "0x0000000000000000000000000000000000cAfE", logIndex: CANDIDATE.logIndex + 1 };
    const cache = new Map<string, Promise<ReorgCheckResult>>();

    await validateV3DiscoveredPoolsBatch(DEPLOYMENT, [CANDIDATE, candidateB], readBlockHash, cache);

    expect(readBlockHash).toHaveBeenCalledTimes(1);
  });
});
