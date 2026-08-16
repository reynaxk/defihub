import { DefiLlamaProvider } from "./defillama";
import { CoinGeckoProvider } from "./coingecko";
import type { DefiDataProvider, PriceProvider } from "./types";

export const defiDataProvider: DefiDataProvider = new DefiLlamaProvider();
export const priceProvider: PriceProvider = new CoinGeckoProvider();

export * from "./types";
