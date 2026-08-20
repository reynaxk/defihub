import { defineChain, type Chain } from "viem";
import { SUPPORTED_CHAINS } from "@/lib/config/chains";

// Public RPC endpoints, verified live before adding (each returned the
// correct eth_chainId for its network). Defaults for chains where the
// operator hasn't set their own RPC via the per-chain env vars below.
const DEFAULT_RPC_URLS: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  "bnb-chain": "https://bsc-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
};

// Maps a chain slug to the env var an operator can set to override the
// public default with their own RPC (Alchemy/Infura/QuickNode etc.).
//
// This module is imported by both server-side consumers (the wallet
// balance-reading API route, the on-chain verification worker) and a client
// component (WalletProvider, to build wagmi's config). These env vars are
// intentionally NOT NEXT_PUBLIC_-prefixed (no reason to ship a private RPC
// URL to every visitor's browser), which means they only resolve to a real
// value in server bundles - in the client bundle rpcUrlFor() always falls
// through to the public DEFAULT_RPC_URLS. That's fine in practice: wagmi's
// own connect/account hooks talk to the injected wallet provider directly,
// not through these configured transports, so the only consumers that
// actually need the operator's override (the balance route, the
// verification worker) run server-side and see the real value.
const RPC_ENV_VARS: Record<string, string | undefined> = {
  ethereum: process.env.ETHEREUM_RPC_URL,
  arbitrum: process.env.ARBITRUM_RPC_URL,
  base: process.env.BASE_RPC_URL,
  "bnb-chain": process.env.BNB_CHAIN_RPC_URL,
  avalanche: process.env.AVALANCHE_RPC_URL,
  polygon: process.env.POLYGON_RPC_URL,
  optimism: process.env.OPTIMISM_RPC_URL,
};

// Throws rather than returning undefined for an unrecognized slug - every
// caller (toViemChain below, the wallet balances route, the on-chain
// verification workers) feeds this straight into viem's http()/defineChain,
// which don't validate their URL argument themselves. A silently-undefined
// URL there doesn't fail where the actual mistake is (a chain added to
// SUPPORTED_CHAINS without a matching entry in the two maps above) - it
// fails later and more confusingly, inside viem's transport. Failing here
// instead means a misconfigured chain breaks loudly at the point that's
// actually wrong, including at module load time for toViemChain's callers.
export function rpcUrlFor(slug: string): string {
  const url = RPC_ENV_VARS[slug] || DEFAULT_RPC_URLS[slug];
  if (!url) {
    throw new Error(`rpcUrlFor: no RPC URL configured for chain "${slug}"`);
  }
  return url;
}

// An optional operator-configured secondary RPC per chain, used by
// withResilientClient (rpc-resilient-client.ts) as a failover target when
// the primary is unavailable. No secondary is ever added automatically -
// an operator opts in per chain by setting the matching env var. Same
// server-only visibility caveat as RPC_ENV_VARS above.
const RPC_FALLBACK_ENV_VARS: Record<string, string | undefined> = {
  ethereum: process.env.ETHEREUM_RPC_URL_FALLBACK,
  arbitrum: process.env.ARBITRUM_RPC_URL_FALLBACK,
  base: process.env.BASE_RPC_URL_FALLBACK,
  "bnb-chain": process.env.BNB_CHAIN_RPC_URL_FALLBACK,
  avalanche: process.env.AVALANCHE_RPC_URL_FALLBACK,
  polygon: process.env.POLYGON_RPC_URL_FALLBACK,
  optimism: process.env.OPTIMISM_RPC_URL_FALLBACK,
};

// Ordered candidate RPC URLs for a chain: the existing primary (operator
// override or public default), followed by an optional configured
// secondary, if any.
export function rpcUrlsFor(slug: string): string[] {
  const urls = [rpcUrlFor(slug)];
  const fallback = RPC_FALLBACK_ENV_VARS[slug];
  if (fallback) urls.push(fallback);
  return urls;
}

// Solana (chainId: null in SUPPORTED_CHAINS) is filtered out here - it isn't
// EVM-compatible and needs a completely separate wallet-adapter/RPC stack
// (@solana/wallet-adapter-*, @solana/web3.js), not viem. Deliberately out of
// scope for both the wallet feature and the on-chain indexer, not an
// oversight.
export const EVM_CHAINS = SUPPORTED_CHAINS.filter(
  (c): c is typeof c & { chainId: number } => c.chainId != null,
);

// Deployed via a deterministic proxy at this exact address on 100+ chains -
// verified live (identical bytecode) on Ethereum, Base and Avalanche before
// relying on it. viem's multicall() needs this declared explicitly on a
// custom chain definition; it doesn't auto-detect it the way it does for
// viem's own built-in chain exports (mainnet, arbitrum, etc., which already
// carry this field) - using defineChain() instead of those built-ins (to
// point at this app's own SUPPORTED_CHAINS/RPC config) meant losing it until
// added back here.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

function toViemChain(chain: (typeof EVM_CHAINS)[number]): Chain {
  const rpcUrl = rpcUrlFor(chain.slug);
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.nativeToken, symbol: chain.nativeToken, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: chain.name, url: chain.explorerUrl } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  });
}

export const VIEM_CHAINS = EVM_CHAINS.map(toViemChain) as [Chain, ...Chain[]];

// Slug -> the matching viem Chain object, so every consumer (wagmi's
// walletConfig, the wallet balances route, the on-chain verification
// worker) reads/writes against the identical chain definition rather than
// each constructing its own separately.
export const VIEM_CHAIN_BY_SLUG = new Map(EVM_CHAINS.map((c, i) => [c.slug, VIEM_CHAINS[i]]));
