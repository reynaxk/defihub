import { erc20Abi, type Address } from "viem";
import { VIEM_CHAIN_BY_SLUG } from "./rpc-client";
import { withResilientClient } from "./rpc-resilient-client";

export interface DecimalsCallResult {
  status: "success" | "failure";
  result?: unknown;
}

// Injected rather than constructed internally, so the batching/failure-
// handling logic below is testable without a real RPC client - production
// code passes a real multicall closure (fetchOnchainDecimals), tests pass a
// fake one. A failed read for a given address is absent from `resolved` -
// callers must treat "not present" as unknown and never substitute an
// assumed value (e.g. 18) - but it IS still reported in `failed`, so a
// partial failure within an otherwise-successful multicall (some
// addresses failed, others didn't) is visible to the caller rather than
// indistinguishable from "every address happened to resolve."
export type MulticallDecimals = (addresses: string[]) => Promise<DecimalsCallResult[]>;

export interface ResolveDecimalsResult {
  resolved: Map<string, number>;
  failed: string[];
}

export async function resolveDecimals(
  addresses: string[],
  multicall: MulticallDecimals,
): Promise<ResolveDecimalsResult> {
  const resolved = new Map<string, number>();
  const failed: string[] = [];
  if (addresses.length === 0) return { resolved, failed };

  const results = await multicall(addresses);
  for (let i = 0; i < addresses.length; i++) {
    const r = results[i];
    // ERC-20 decimals() returns a uint8 - a bare `typeof === "number"`
    // check accepts anything numeric, including negatives, fractions,
    // NaN, Infinity, and values above 255, none of which are a valid
    // uint8. workers/tokens/sync.ts persists whatever comes out of here
    // straight into tokens.decimals, which every balance display then
    // scales by - a malformed value here would corrupt that scaling (or
    // fail the upsert outright for something like NaN/Infinity, which
    // Postgres's numeric/integer columns reject).
    if (
      r &&
      r.status === "success" &&
      typeof r.result === "number" &&
      Number.isInteger(r.result) &&
      r.result >= 0 &&
      r.result <= 255
    ) {
      resolved.set(addresses[i], r.result);
    } else {
      failed.push(addresses[i]);
    }
  }
  return { resolved, failed };
}

// One multicall batching every address's decimals() read for a single
// chain, through the resilient RPC wrapper (rpc-resilient-client.ts) for
// retry/failover consistency with the wallet-balances route and the
// on-chain verification workers. Chains with no viem chain definition
// (non-EVM, e.g. Solana) simply aren't callable here - the token-sync
// worker skips this function entirely for those and leaves decimals
// unknown, which is correct: there's no RPC to read a real value from. A
// whole-chain RPC failure (all configured providers exhausted) is left to
// the caller (workers/tokens/sync.ts) to catch per-chain, same as before.
export async function fetchOnchainDecimals(
  chainSlug: string,
  addresses: string[],
): Promise<ResolveDecimalsResult> {
  if (addresses.length === 0) return { resolved: new Map(), failed: [] };
  // Non-EVM chains aren't a per-address failure - there's no RPC to have
  // failed against, so nothing goes in `failed` here either.
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) return { resolved: new Map(), failed: [] };

  return resolveDecimals(addresses, (addrs) =>
    withResilientClient(chainSlug, async (client) => {
      const results = await client.multicall({
        contracts: addrs.map((address) => ({
          address: address as Address,
          abi: erc20Abi,
          functionName: "decimals",
        })),
        // Explicit rather than relying on viem's implicit default (which is
        // already `true`) - a per-address failure must come back as a
        // failed result for this address, never abort the whole batch.
        allowFailure: true,
      });
      return results as DecimalsCallResult[];
    }),
  );
}
