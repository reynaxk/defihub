import { z } from "zod";
import type { NormalizedPrice, PriceProvider } from "./types";
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class CoinGeckoProvider implements PriceProvider {
  constructor(private readonly apiKey = process.env.COINGECKO_API_KEY) {}

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

      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/simple/price?${params.toString()}`, {
          headers: {
            accept: "application/json",
            ...(this.apiKey ? { "x-cg-demo-api-key": this.apiKey } : {}),
          },
        });
      } catch (cause) {
        throw new ProviderUnavailableError("coingecko", "network error fetching prices", cause);
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

      const json = await res.json();
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
}
