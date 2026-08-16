import { z } from "zod";
import type { NormalizedMarketToken, NormalizedPrice, PriceProvider, TokenDiscoveryProvider } from "./types";
import { ProviderUnavailableError } from "./types";

const BASE_URL = "https://api.coingecko.com/api/v3";
const CHUNK_SIZE = 100; // keeps URLs short and calls cheap against the free rate limit

const simplePriceSchema = z.record(
  z.string(),
  z.object({
    usd: z.number().optional(),
    usd_market_cap: z.number().optional(),
    usd_24h_vol: z.number().optional(),
  }),
);

const marketsSchema = z.array(
  z.object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    image: z.string().nullable().optional(),
    current_price: z.number().nullable(),
    market_cap: z.number().nullable(),
    total_volume: z.number().nullable(),
  }),
);

const coinListSchema = z.array(
  z.object({
    id: z.string(),
    platforms: z.record(z.string(), z.string()).optional(),
  }),
);

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class CoinGeckoProvider implements PriceProvider, TokenDiscoveryProvider {
  constructor(private readonly apiKey = process.env.COINGECKO_API_KEY) {}

  private async fetchJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          accept: "application/json",
          ...(this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {}),
        },
      });
    } catch (cause) {
      throw new ProviderUnavailableError("coingecko", "network error", cause);
    }

    if (res.status === 429) {
      throw new ProviderUnavailableError(
        "coingecko",
        "rate limited (429) - consider setting COINGECKO_API_KEY for a higher quota",
      );
    }
    if (!res.ok) {
      throw new ProviderUnavailableError("coingecko", `${res.status} ${res.statusText}`);
    }

    return res.json();
  }

  async getPrices(coingeckoIds: string[]): Promise<NormalizedPrice[]> {
    if (coingeckoIds.length === 0) return [];

    const results: NormalizedPrice[] = [];
    for (const batch of chunk(coingeckoIds, CHUNK_SIZE)) {
      const params = new URLSearchParams({
        ids: batch.join(","),
        vs_currencies: "usd",
        include_market_cap: "true",
        include_24hr_vol: "true",
      });

      const json = await this.fetchJson(`/simple/price?${params.toString()}`);
      const parsed = simplePriceSchema.safeParse(json);
      if (!parsed.success) {
        throw new ProviderUnavailableError(
          "coingecko",
          `unexpected response shape: ${parsed.error.message}`,
        );
      }

      for (const [id, entry] of Object.entries(parsed.data)) {
        if (entry.usd == null) continue;
        results.push({
          id,
          priceUsd: entry.usd,
          marketCap: entry.usd_market_cap ?? null,
          volume24h: entry.usd_24h_vol ?? null,
        });
      }
    }
    return results;
  }

  async getTopMarketTokens(limit: number): Promise<NormalizedMarketToken[]> {
    const marketsParams = new URLSearchParams({
      vs_currency: "usd",
      order: "market_cap_desc",
      per_page: String(Math.min(limit, 250)),
      page: "1",
      sparkline: "false",
    });

    // /coins/markets doesn't carry contract addresses - /coins/list does
    // (for every coin CoinGecko tracks), so a second call cross-references
    // platforms onto the market-cap-ranked set from the first.
    const [marketsJson, listJson] = await Promise.all([
      this.fetchJson(`/coins/markets?${marketsParams.toString()}`),
      this.fetchJson("/coins/list?include_platform=true"),
    ]);

    const marketsParsed = marketsSchema.safeParse(marketsJson);
    if (!marketsParsed.success) {
      throw new ProviderUnavailableError(
        "coingecko",
        `unexpected /coins/markets response shape: ${marketsParsed.error.message}`,
      );
    }
    const listParsed = coinListSchema.safeParse(listJson);
    if (!listParsed.success) {
      throw new ProviderUnavailableError(
        "coingecko",
        `unexpected /coins/list response shape: ${listParsed.error.message}`,
      );
    }

    const platformsById = new Map(listParsed.data.map((c) => [c.id, c.platforms ?? {}]));

    return marketsParsed.data.map((m) => ({
      coingeckoId: m.id,
      symbol: m.symbol.toUpperCase(),
      name: m.name,
      logoUrl: m.image ?? null,
      priceUsd: m.current_price,
      marketCap: m.market_cap,
      volume24h: m.total_volume,
      platforms: platformsById.get(m.id) ?? {},
    }));
  }
}
