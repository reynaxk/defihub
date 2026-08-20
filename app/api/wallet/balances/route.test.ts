import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// This repo's first API-route test. Everything the route touches besides
// pure math (viem's real formatUnits/isAddress, and the real
// aggregateUsdValues/computeValueUsd) is mocked, so this exercises the
// route's own orchestration logic - specifically the decimals fallback
// chain introduced by making tokens.decimals nullable (schema.ts) - without
// a live RPC or database.

const mockGetBalance = vi.fn();
const mockMulticall = vi.fn();

vi.mock("viem", async (importActual) => {
  const actual = await importActual<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getBalance: mockGetBalance, multicall: mockMulticall }),
  };
});

vi.mock("@/lib/auth/config", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

const mockGetTokensForBalanceCheck = vi.fn();
vi.mock("@/lib/database/queries/tokens", () => ({
  getTokensForBalanceCheck: (...args: unknown[]) => mockGetTokensForBalanceCheck(...args),
  getNativeTokenPrice: vi.fn(async () => 2000),
}));

// The route goes through withResilientClient (rpc-resilient-client.ts,
// not mocked - its retry/classification logic runs for real), which in
// turn reads chain config from this module.
vi.mock("@/lib/chains/rpc-client", () => ({
  EVM_CHAINS: [{ slug: "ethereum", name: "Ethereum", nativeToken: "ETH", chainId: 1 }],
  VIEM_CHAIN_BY_SLUG: new Map([["ethereum", {}]]),
  rpcUrlsFor: () => ["http://fake-rpc.invalid"],
}));

const TEST_ADDRESS = "0x" + "0".repeat(36) + "dead";

describe("GET /api/wallet/balances", () => {
  let GET: typeof import("./route").GET;

  // The dynamic import below pulls in next/server's module graph for the
  // first time in this process, which is slow well beyond vitest's default
  // 5s test timeout on a cold run - hoisting it into beforeAll (with its own
  // longer timeout) means only this one hook pays that cost; every `it`
  // below reuses the already-resolved module.
  beforeAll(async () => {
    ({ GET } = await import("./route"));
  }, 30_000);

  beforeEach(() => {
    mockGetBalance.mockReset();
    mockMulticall.mockReset();
    mockGetTokensForBalanceCheck.mockReset();
  });

  it("drops a token balance when the on-chain decimals read fails and the DB has no confirmed value", async () => {
    mockGetTokensForBalanceCheck.mockResolvedValue([
      { address: "0xtoken", symbol: "TOK", decimals: null, logoUrl: null, priceUsd: 1 },
    ]);
    mockGetBalance.mockResolvedValue(BigInt(0));
    mockMulticall.mockResolvedValue([
      { status: "success", result: BigInt(500_000) }, // balanceOf: nonzero
      { status: "failure" }, // decimals(): failed
    ]);

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${TEST_ADDRESS}`));
    const body = await response.json();

    expect(body.chains[0].tokenBalances).toEqual([]);
    // The dropped balance had unknown (not zero) value - the response must
    // not silently claim completeness it doesn't have.
    expect(body.chains[0].isPartial).toBe(true);
    expect(body.isPartial).toBe(true);
  });

  it("uses the live on-chain decimals value when the read succeeds, ignoring a conflicting DB value", async () => {
    mockGetTokensForBalanceCheck.mockResolvedValue([
      { address: "0xtoken", symbol: "TOK", decimals: 18, logoUrl: null, priceUsd: 1 },
    ]);
    mockGetBalance.mockResolvedValue(BigInt(0));
    mockMulticall.mockResolvedValue([
      { status: "success", result: BigInt(1_000_000) }, // 1 token at 6 decimals
      { status: "success", result: 6 },
    ]);

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${TEST_ADDRESS}`));
    const body = await response.json();

    expect(body.chains[0].tokenBalances).toHaveLength(1);
    expect(body.chains[0].tokenBalances[0].balance).toBe("1");
  });

  it("falls back to a confirmed DB decimals value when the live on-chain read fails", async () => {
    mockGetTokensForBalanceCheck.mockResolvedValue([
      { address: "0xtoken", symbol: "TOK", decimals: 6, logoUrl: null, priceUsd: 1 },
    ]);
    mockGetBalance.mockResolvedValue(BigInt(0));
    mockMulticall.mockResolvedValue([
      { status: "success", result: BigInt(1_000_000) },
      { status: "failure" },
    ]);

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${TEST_ADDRESS}`));
    const body = await response.json();

    expect(body.chains[0].tokenBalances).toHaveLength(1);
    expect(body.chains[0].tokenBalances[0].balance).toBe("1");
  });
});
