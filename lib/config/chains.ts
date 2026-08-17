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
  {
    name: "Avalanche",
    slug: "avalanche",
    chainId: 43114,
    nativeToken: "AVAX",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg",
    explorerUrl: "https://snowtrace.io",
    defillamaSlug: "Avalanche",
    coingeckoPlatformId: "avalanche",
  },
  {
    name: "Polygon",
    slug: "polygon",
    chainId: 137,
    nativeToken: "POL",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_polygon.jpg",
    explorerUrl: "https://polygonscan.com",
    defillamaSlug: "Polygon",
    coingeckoPlatformId: "polygon-pos",
  },
  {
    name: "Optimism",
    slug: "optimism",
    chainId: 10,
    // Gas is paid in ETH, same as Arbitrum/Base above - DefiLlama's own
    // `tokenSymbol` field for this chain says "OP" (their governance
    // token), but that's not what you pay gas with, and we already
    // treat "nativeToken" as the real gas currency for the other two
    // ETH-gas L2s, so this stays consistent with that rather than DefiLlama's field.
    nativeToken: "ETH",
    logoUrl: "https://icons.llamao.fi/icons/chains/rsz_optimism.jpg",
    explorerUrl: "https://optimistic.etherscan.io",
    // DefiLlama is inconsistent with itself here: /v2/chains and
    // /v2/historicalChainTvl call this chain "OP Mainnet", but every
    // protocol's own `chains` array (from /protocols) lists it as
    // "Optimism" - confirmed directly against both live endpoints.
    // "Optimism" is the one that actually matters, since protocol-chain
    // linking depends on matching against that array; the TVL history
    // endpoint accepts both names for the same underlying data.
    defillamaSlug: "Optimism",
    coingeckoPlatformId: "optimistic-ethereum",
  },
];

export const DEFILLAMA_SLUG_TO_CHAIN_SLUG = new Map(
  SUPPORTED_CHAINS.map((c) => [c.defillamaSlug, c.slug]),
);

export const COINGECKO_PLATFORM_TO_CHAIN_SLUG = new Map(
  SUPPORTED_CHAINS.map((c) => [c.coingeckoPlatformId, c.slug]),
);
