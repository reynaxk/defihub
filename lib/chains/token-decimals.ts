import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { VIEM_CHAIN_BY_SLUG, rpcUrlFor } from "./rpc-client";

export interface DecimalsCallResult {
  status: "success" | "failure";
  result?: unknown;
}

// Injected rather than constructed internally, so the batching/failure-
// handling logic below is testable without a real RPC client - production
// code passes a real multicall closure (fetchOnchainDecimals), tests pass a
// fake one. A failed read for a given address is simply absent from the
// returned map - callers must treat "not present" as unknown and never
// substitute an assumed value (e.g. 18).
export type MulticallDecimals = (addresses: string[]) => Promise<DecimalsCallResult[]>;

export async function resolveDecimals(
  addresses: string[],
  multicall: MulticallDecimals,
): Promise<Map<string, number>> {
  const byAddress = new Map<string, number>();
  if (addresses.length === 0) return byAddress;

  const results = await multicall(addresses);
  for (let i = 0; i < addresses.length; i++) {
    const r = results[i];
    if (r && r.status === "success" && typeof r.result === "number") {
      byAddress.set(addresses[i], r.result);
    }
  }
  return byAddress;
}

// One multicall batching every address's decimals() read for a single
// chain. Chains with no viem chain definition (non-EVM, e.g. Solana) simply
// aren't callable here - the token-sync worker skips this function entirely
// for those and leaves decimals unknown, which is correct: there's no RPC
// to read a real value from.
//
// TODO(Phase E): rewire through the resilient RPC wrapper once it lands,
// same as the wallet-balances route and the on-chain verification workers.
export async function fetchOnchainDecimals(
  chainSlug: string,
  addresses: string[],
): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();

  const viemChain = VIEM_CHAIN_BY_SLUG.get(chainSlug);
  if (!viemChain) return new Map();

  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrlFor(chainSlug)) });

  return resolveDecimals(addresses, async (addrs) => {
    const results = await client.multicall({
      contracts: addrs.map((address) => ({
        address: address as Address,
        abi: erc20Abi,
        functionName: "decimals",
      })),
    });
    return results as DecimalsCallResult[];
  });
}
