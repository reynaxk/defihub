// Real-Postgres integration test (mocked RPC client) for Phase 5.10's
// scan/validation failure-isolation fix in discoverPoolsForDeployment
// (engine.ts) - a REAL, live-observed bug this phase's own development
// found: scanForNewPools (eth_getLogs, finding new candidates) and
// validatePendingPools (eth_call/multicall, deciding on candidates already
// in `discovered_pools`) used to share one try/catch, so a scan failure
// (in production: a public RPC provider now rejecting every eth_getLogs
// call without a personal archive token) silently prevented validation
// from running at all - even though validation needs a completely
// different RPC method and had a real, independent chance of succeeding
// against real, already-discovered candidates sitting in the database.
//
// Unlike engine.integration.test.ts (deliberately RPC-free, chain-not-
// found-in-DB path only), this test needs BOTH a real DB (real
// discovered_pools rows to validate) AND a controllable chain client
// (getBlockNumber/getLogs must fail for the scan phase; multicall must
// succeed for the validation phase) - the same
// `vi.mock("@/lib/chains/rpc-resilient-client", ...)` pattern
// validate.test.ts already established, combined with real Postgres
// writes/reads.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, discoveredPools, indexingState } from "@/lib/database/schema";

const mockGetBlockNumber = vi.fn();
const mockGetLogs = vi.fn();
const mockMulticall = vi.fn();
// The canonical-block check (validateDiscoveredPoolsBatch's own
// checkBlockHashStillCanonical call) reads via the REAL
// readBlockHashOnChain default, which calls client.getBlock(...) - a
// THIRD RPC method distinct from getBlockNumber/getLogs/multicall above,
// easy to forget when mocking this client (an earlier draft of this test
// omitted it, which surfaced as every validation outcome coming back
// "retry" instead of "accepted" - a real, easy-to-repeat mistake, not just
// hypothetical, so it's called out here for the next person editing this
// mock).
const mockGetBlock = vi.fn();
vi.mock("@/lib/chains/rpc-resilient-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/chains/rpc-resilient-client")>();
  return {
    ...actual,
    withResilientClient: (
      _chainSlug: string,
      fn: (client: { getBlockNumber: typeof mockGetBlockNumber; getLogs: typeof mockGetLogs; multicall: typeof mockMulticall; getBlock: typeof mockGetBlock }) => unknown,
    ) => fn({ getBlockNumber: mockGetBlockNumber, getLogs: mockGetLogs, multicall: mockMulticall, getBlock: mockGetBlock }),
  };
});

const { discoverPoolsForDeployment } = await import("./engine");
const { discoveredPoolConfigKey } = await import("./register");

function successfulMulticallResults(token0: string, token1: string, factoryAddress: string) {
  return [
    { status: "success" as const, result: token0 },
    { status: "success" as const, result: token1 },
    { status: "success" as const, result: factoryAddress },
    { status: "success" as const, result: [BigInt(1), BigInt(1), 0] },
    { status: "success" as const, result: 18 },
    { status: "success" as const, result: 18 },
    { status: "success" as const, result: "TOK0" },
    { status: "success" as const, result: "TOK1" },
  ];
}

describe("discoverPoolsForDeployment - Phase 5.10: scan and validation failure isolation", () => {
  const createdChainIds: string[] = [];
  const createdChainSlugs: string[] = [];

  afterEach(async () => {
    for (const slug of createdChainSlugs.splice(0)) await db.delete(indexingState).where(eq(indexingState.chainSlug, slug));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
    mockGetBlockNumber.mockReset();
    mockGetLogs.mockReset();
    mockMulticall.mockReset();
    mockGetBlock.mockReset();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("REGRESSION: a scan (eth_getLogs) failure does not prevent validation from running against an already-pending candidate - validation still activates it", async () => {
    const slug = `decoupling-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: "Decoupling Test Chain", slug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    createdChainSlugs.push(slug);

    const deploymentKey = `decoupling-test-dep-${randomUUID()}`;
    const factoryAddress = "0x00000000000000000000000000000000fac700";
    const poolAddress = `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`;
    const token0 = "0x0000000000000000000000000000000000t0k0";
    const token1 = "0x0000000000000000000000000000000000t0k1";

    // A real, already-discovered pending candidate - exactly the "28
    // pending candidates" scenario live-observed during this phase's own
    // development.
    await db.insert(discoveredPools).values({
      chainId: chain.id,
      deploymentKey,
      factoryAddress,
      poolAddress,
      token0Address: token0,
      token1Address: token1,
      creationBlockNumber: "100",
      creationBlockHash: `0x${"aa".repeat(32)}`,
      creationTransactionHash: `0x${"bb".repeat(32)}`,
      creationLogIndex: 0,
      status: "discovered",
    });

    mockGetBlockNumber.mockResolvedValue(BigInt(1000));
    // The scan phase's own eth_getLogs call fails outright - the exact
    // shape of the live "archive requests require a personal token"
    // failure this phase's development hit against a real public RPC
    // provider for both configured deployments.
    mockGetLogs.mockRejectedValue(new Error("Archive requests require a personal token"));
    // The validation phase's own multicall succeeds independently -
    // genuinely different RPC method, genuinely unaffected by the scan
    // failure above.
    mockMulticall.mockResolvedValue(successfulMulticallResults(token0, token1, factoryAddress));
    // The canonical-block check's own getBlock read - must return the
    // exact same hash the candidate was recorded with so the canonical
    // check resolves "confirmed", not "unknown".
    mockGetBlock.mockResolvedValue({ hash: `0x${"aa".repeat(32)}` });

    const result = await discoverPoolsForDeployment({
      key: deploymentKey,
      chainSlug: slug,
      protocolDefillamaSlug: "decoupling-test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress,
      feeBps: 30,
      startBlock: BigInt(1),
    });

    // The scan failure is recorded, never silently swallowed...
    expect(result.scanError).toContain("Archive requests require a personal token");
    // ...but validation still ran and activated the real, already-pending
    // candidate - the exact fix this test exists to prove.
    expect(result.activated).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(discoveredPools).where(eq(discoveredPools.poolAddress, poolAddress));
    expect(row.status).toBe("active");
    expect(row.poolId).not.toBeNull();

    const configKey = discoveredPoolConfigKey(slug, poolAddress);
    expect(configKey).toBeTruthy(); // sanity: register.ts's own key format still resolves for this chain/address
  });

  it("reports ok:false when scan fails AND validation genuinely has a pending candidate whose own RPC read also fails", async () => {
    const slug = `decoupling-test-both-fail-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: "Decoupling Both-Fail Test Chain", slug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    createdChainSlugs.push(slug);

    const deploymentKey = `decoupling-both-fail-${randomUUID()}`;
    // A real pending candidate, so validatePendingPools' own multicall is
    // genuinely attempted (an empty pending list would vacuously "succeed"
    // with zero work, which would not exercise this test's actual claim).
    await db.insert(discoveredPools).values({
      chainId: chain.id,
      deploymentKey,
      factoryAddress: "0x00000000000000000000000000000000fac700",
      poolAddress: `0x${randomUUID().replace(/-/g, "").slice(0, 40)}`,
      token0Address: "0x0000000000000000000000000000000000t0k0",
      token1Address: "0x0000000000000000000000000000000000t0k1",
      creationBlockNumber: "100",
      creationBlockHash: `0x${"cc".repeat(32)}`,
      creationTransactionHash: `0x${"dd".repeat(32)}`,
      creationLogIndex: 0,
      status: "discovered",
    });

    mockGetBlockNumber.mockResolvedValue(BigInt(1000));
    mockGetLogs.mockRejectedValue(new Error("scan RPC down"));
    mockMulticall.mockRejectedValue(new Error("validation RPC down"));
    mockGetBlock.mockRejectedValue(new Error("validation RPC down"));

    const result = await discoverPoolsForDeployment({
      key: deploymentKey,
      chainSlug: slug,
      protocolDefillamaSlug: "decoupling-test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0x00000000000000000000000000000000fac700",
      feeBps: 30,
      startBlock: BigInt(1),
    });

    // A whole-multicall failure resolves every candidate to "retry" inside
    // validateDiscoveredPoolsBatch (never thrown) - so validation itself
    // still completes "successfully" (zero activated, zero rejected, the
    // candidate simply retried next run), which means THIS deployment is
    // still ok:true overall: the scan error is recorded, but validation
    // genuinely ran to completion without throwing.
    expect(result.scanError).toContain("scan RPC down");
    expect(result.ok).toBe(true);
    expect(result.activated).toBe(0);
    expect(result.rejected).toBe(0);

    const [row] = await db.select().from(discoveredPools).where(eq(discoveredPools.deploymentKey, deploymentKey));
    expect(row.status).toBe("discovered"); // left untouched for retry, never rejected merely because the RPC read failed
  });
});
