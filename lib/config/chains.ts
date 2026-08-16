// Phase 1 supported chains. Adding a chain later is a matter of appending a
// row here and re-running `npm run seed` — nothing else in the ingestion
// pipeline or UI is chain-specific.

export interface SupportedChain {
  name: string; // display name, also the DefiLlama chain name used for matching
  slug: string;
  chainId: number | null; // EVM chain id; null for non-EVM
  nativeToken: string;
  logoUrl: string;
  explorerUrl: string;
  defillamaSlug: string; // DefiLlama's `name` field, used to join provider data
  coingeckoPlatformId: string; // CoinGecko's asset-platform id, used to join token contract data
}

export const SUPPORTED_CHAINS: SupportedChain[] = [
  {
    name: "Ethereum",
    slug: "ethereum",
    chainId: 1,
    nativeToken: "ETH",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg",
    explorerUrl: "https://etherscan.io",
    defillamaSlug: "Ethereum",
    coingeckoPlatformId: "ethereum",
  },
  {
    name: "Solana",
    slug: "solana",
    chainId: null,
    nativeToken: "SOL",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_solana.jpg",
    explorerUrl: "https://solscan.io",
    defillamaSlug: "Solana",
    coingeckoPlatformId: "solana",
  },
  {
    name: "Arbitrum",
    slug: "arbitrum",
    chainId: 42161,
    nativeToken: "ETH",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
    explorerUrl: "https://arbiscan.io",
    defillamaSlug: "Arbitrum",
    coingeckoPlatformId: "arbitrum-one",
  },
  {
    name: "Base",
    slug: "base",
    chainId: 8453,
    nativeToken: "ETH",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_base.jpg",
    explorerUrl: "https://basescan.org",
    defillamaSlug: "Base",
    coingeckoPlatformId: "base",
  },
  {
    name: "BNB Chain",
    slug: "bnb-chain",
    chainId: 56,
    nativeToken: "BNB",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_binance.jpg",
    explorerUrl: "https://bscscan.com",
    defillamaSlug: "BSC",
    coingeckoPlatformId: "binance-smart-chain",
  },
];

export const DEFILLAMA_SLUG_TO_CHAIN_SLUG = new Map(
  SUPPORTED_CHAINS.map((c) => [c.defillamaSlug, c.slug]),
);

export const COINGECKO_PLATFORM_TO_CHAIN_SLUG = new Map(
  SUPPORTED_CHAINS.map((c) => [c.coingeckoPlatformId, c.slug]),
);
