// Minimal raw JSON-RPC client for the handful of read-only `eth_call`s the
// on-chain verification feature needs (lib/onchain/verify-pool.ts). No
// ethers/viem dependency - two ABI-encoded calls (`balanceOf`, block number)
// don't warrant one.

import { ProviderUnavailableError } from "@/lib/providers/types";

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";

function rpcUrl(): string {
  return process.env.ETH_RPC_URL || DEFAULT_RPC_URL;
}

async function rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (cause) {
    throw new ProviderUnavailableError("eth-rpc", "network error", cause);
  }

  if (!res.ok) {
    throw new ProviderUnavailableError("eth-rpc", `${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) {
    throw new ProviderUnavailableError("eth-rpc", json.error.message);
  }
  if (json.result === undefined) {
    throw new ProviderUnavailableError("eth-rpc", "empty result");
  }
  return json.result;
}

/** Encodes `balanceOf(address)` calldata (selector 0x70a08231). */
function encodeBalanceOf(holder: string): string {
  const padded = holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return `0x70a08231${padded}`;
}

export async function getBlockNumber(): Promise<number> {
  const hex = await rpcRequest<string>("eth_blockNumber", []);
  return Number.parseInt(hex, 16);
}

/** Reads an ERC-20 balance via `eth_call`, returned as a raw bigint (no decimals applied). */
export async function getErc20Balance(tokenAddress: string, holderAddress: string): Promise<bigint> {
  const data = encodeBalanceOf(holderAddress);
  const hex = await rpcRequest<string>("eth_call", [{ to: tokenAddress, data }, "latest"]);
  return BigInt(hex);
}
