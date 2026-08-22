// Provider-agnostic types. Nothing outside /lib/providers should ever see a
// raw DefiLlama or CoinGecko response shape — adapters normalize into these.

export class ProviderUnavailableError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderUnavailableError";
  }
}

export interface NormalizedProtocol {
  externalId: string;
  name: string;
  slug: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  category: string | null;
  chains: string[]; // provider chain names, e.g. "Ethereum", "BSC"
  tvl: number | null;
  tvlByChain: Record<string, number>;
  tvlChange1d: number | null; // percent, e.g. 3.45 = +3.45%, as reported by the provider
  tvlChange7d: number | null;
}

export interface NormalizedProtocolFinancials {
  externalId: string;
  fees24h: number | null;
  revenue24h: number | null;
  volume24h: number | null;
}

export interface NormalizedChain {
  name: string; // provider chain name, used as the join key to our `chains` table
  tvl: number;
  tokenSymbol: string | null;
  chainId: number | null;
}

export interface ChainTvlPoint {
  timestamp: Date;
  tvl: number;
}

export interface NormalizedYieldPool {
  externalPoolId: string;
  protocolExternalSlug: string | null; // provider's protocol slug, e.g. "lido"
  chain: string; // provider chain name
  symbol: string;
  underlyingTokens: string[];
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number | null;
  stablecoin: boolean;
  ilRisk: string | null;
}

/**
 * Aggregated DeFi data (TVL, fees, revenue, volume, yields). Implemented by
 * `defillama.ts` today; swappable for another aggregator without touching
 * callers.
 */
export interface DefiDataProvider {
  getProtocols(): Promise<NormalizedProtocol[]>;
  getProtocolFees(): Promise<NormalizedProtocolFinancials[]>;
  getProtocolVolume(): Promise<Map<string, number>>; // externalId -> 24h volume
  getChains(): Promise<NormalizedChain[]>;
  getChainTvlHistory(chainName: string): Promise<ChainTvlPoint[]>;
  getYieldPools(): Promise<NormalizedYieldPool[]>;
}

export interface NormalizedPrice {
  id: string; // the id passed in (coingeckoId)
  priceUsd: number;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null; // percent, e.g. 3.45 = +3.45%
}

/**
 * Token price data. Implemented by `coingecko.ts` today.
 */
export interface PriceProvider {
  // Stable identifier for the concrete provider instance (e.g.
  // "coingecko") - lets a caller that needs to record where a price came
  // from (historical_observations' provenance columns) do so honestly,
  // without hardcoding a provider name that would silently go stale if
  // this instance were ever swapped for a different implementation.
  readonly name: string;
  getPrices(coingeckoIds: string[]): Promise<NormalizedPrice[]>;
}

export interface NormalizedMarketToken {
  coingeckoId: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null; // percent, e.g. 3.45 = +3.45%
  priceChange7d: number | null;
  // CoinGecko asset-platform id (e.g. "ethereum", "arbitrum-one") -> contract
  // address on that chain. Native/no-platform assets (BTC, etc.) have {}.
  platforms: Record<string, string>;
}

/**
 * Token discovery by market cap, with per-chain contract addresses.
 * Implemented by `coingecko.ts` today.
 */
export interface TokenDiscoveryProvider {
  getTopMarketTokens(limit: number): Promise<NormalizedMarketToken[]>;
}
