import { NextResponse } from "next/server";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress, type Address } from "viem";
import { auth } from "@/lib/auth/config";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getTokensForBalanceCheck } from "@/lib/database/queries/tokens";
import { EVM_CHAINS, VIEM_CHAIN_BY_SLUG, rpcUrlFor } from "@/lib/chains/rpc-client";

// Each request fans out to 7 chains' RPC endpoints (1 native balance + 1
// multicall each) - modest per-user cap since this is real external RPC
// load, not a free local computation.
const BALANCE_CHECK_LIMIT = { limit: 20, windowMs: 60 * 1000 };

interface TokenBalance {
  symbol: string;
  address: string;
  logoUrl: string | null;
  balance: string;
}

interface ChainBalanceResult {
  chainSlug: string;
  chainName: string;
  nativeToken: string;
  nativeBalance: string;
  tokenBalances: TokenBalance[];
}

async function readChainBalances(
  chain: (typeof EVM_CHAINS)[number],
  address: Address,
): Promise<ChainBalanceResult> {
  const viemChain = VIEM_CHAIN_BY_SLUG.get(chain.slug);
  if (!viemChain) throw new Error(`No viem chain definition for ${chain.slug}`);

  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrlFor(chain.slug)) });
  // Some chains have a tracked "token" row that's actually just a pseudo-
  // ERC-20 representation of the native currency itself - confirmed live on
  // Polygon, where address 0x...1010 (a real, documented Polygon-specific
  // convention some indexers use to expose native POL via balanceOf) sits
  // alongside a plain zero-address placeholder row, both symbol "POL". The
  // zero-address one already fails harmlessly (no contract there), but the
  // 0x...1010 one succeeds and duplicates the native balance shown below.
  // Filtering by symbol match against the chain's own native token, rather
  // than hardcoding known pseudo-addresses per chain, since the failure
  // mode (double-counting the same balance) is the same regardless of which
  // specific placeholder convention a given chain happens to use.
  const trackedTokens = (await getTokensForBalanceCheck(chain.slug)).filter(
    (t) => t.symbol !== chain.nativeToken,
  );

  // Reads decimals() on-chain rather than trusting tokens.decimals from the
  // DB - confirmed live that column is wrong for most tokens (e.g. USDT
  // stored as 18 instead of its real 6), because workers/tokens/sync.ts
  // never actually populates it from CoinGecko (whose bulk sync endpoint
  // doesn't return per-token decimals anyway) and it silently falls back to
  // the schema's `default(18)` for every row. That's a separate, pre-existing
  // data-quality bug in the sync pipeline, out of scope to fix here - but
  // this route needs correct decimals to not display wildly wrong balances,
  // and it's already calling multicall on these exact contracts, so reading
  // the real value straight from each token contract is both more correct
  // and doesn't need to wait on that sync fix.
  const [nativeBalance, multicallResults] = await Promise.all([
    client.getBalance({ address }),
    trackedTokens.length === 0
      ? []
      : client.multicall({
          contracts: [
            ...trackedTokens.map((t) => ({
              address: t.address as Address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            })),
            ...trackedTokens.map((t) => ({
              address: t.address as Address,
              abi: erc20Abi,
              functionName: "decimals",
            })),
          ],
        }),
  ]);

  const tokenBalances: TokenBalance[] = trackedTokens
    .map((token, i) => {
      const balanceResult = multicallResults[i];
      const decimalsResult = multicallResults[trackedTokens.length + i];
      if (!balanceResult || balanceResult.status !== "success") return null;
      // balanceOf/decimals always return a uint256/uint8 - viem's multicall
      // return type widens to string | number | bigint here since the
      // contracts array is built via .map() rather than a literal tuple,
      // losing per-call inference.
      const balance = balanceResult.result as bigint;
      if (balance === BigInt(0)) return null;
      // Fall back to the DB value only if the on-chain read itself failed
      // (e.g. a non-standard token missing decimals()) - better than
      // dropping the balance entirely.
      const decimals =
        decimalsResult && decimalsResult.status === "success"
          ? (decimalsResult.result as number)
          : token.decimals;
      return {
        symbol: token.symbol,
        address: token.address,
        logoUrl: token.logoUrl,
        balance: formatUnits(balance, decimals),
      };
    })
    .filter((t): t is TokenBalance => t !== null);

  return {
    chainSlug: chain.slug,
    chainName: chain.name,
    nativeToken: chain.nativeToken,
    nativeBalance: formatUnits(nativeBalance, 18),
    tokenBalances,
  };
}

interface ChainBalanceError {
  chainSlug: string;
  chainName: string;
  error: string;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit(`wallet-balances:${session.user.id}`, BALANCE_CHECK_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "A valid EVM wallet address is required" }, { status: 400 });
  }

  const settled = await Promise.allSettled(
    EVM_CHAINS.map((chain) => readChainBalances(chain, address)),
  );

  // A single chain's RPC being slow/unreachable doesn't fail the whole
  // response - the other chains' results still render, with this one
  // shown as a per-chain error instead. The real reason is logged
  // server-side (not swallowed) - a generic client-facing message here
  // previously hid a real config bug (missing multicall3 contract address)
  // behind "couldn't reach this chain" for every chain, making it far
  // harder to diagnose than it needed to be.
  const chains: (ChainBalanceResult | ChainBalanceError)[] = settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    console.error(`[wallet-balances] ${EVM_CHAINS[i].slug} failed:`, result.reason);
    return { chainSlug: EVM_CHAINS[i].slug, chainName: EVM_CHAINS[i].name, error: "Couldn't reach this chain" };
  });

  return NextResponse.json({ address, chains });
}
