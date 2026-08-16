import { DefiLlamaProvider } from "./defillama";
import { CoinGeckoProvider } from "./coingecko";
import type { DefiDataProvider, PriceProvider, TokenDiscoveryProvider } from "./types";

const coinGecko = new CoinGeckoProvider();

export const defiDataProvider: DefiDataProvider = new DefiLlamaProvider();
export const priceProvider: PriceProvider = coinGecko;
export const tokenDiscoveryProvider: TokenDiscoveryProvider = coinGecko;

export * from "./types";
