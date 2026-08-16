import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoinGeckoProvider } from "./coingecko";
import { ProviderUnavailableError } from "./types";

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

describe("CoinGeckoProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes a real-shaped /simple/price response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ethereum: {
          usd: 4109.5,
          usd_market_cap: 494_000_000_000,
          usd_24h_vol: 18_000_000_000,
          usd_24h_change: 2.34,
        },
      }),
    );

    const provider = new CoinGeckoProvider("test-key");
    const prices = await provider.getPrices(["ethereum"]);

    expect(prices).toEqual([
      {
        id: "ethereum",
        priceUsd: 4109.5,
        marketCap: 494_000_000_000,
        volume24h: 18_000_000_000,
        priceChange24h: 2.34,
      },
    ]);
  });

  it("returns an empty array without calling fetch for an empty id list", async () => {
    const provider = new CoinGeckoProvider("test-key");
    const prices = await provider.getPrices([]);

    expect(prices).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips entries with no usd price rather than emitting a bogus zero", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ethereum: { usd: 4109.5 },
        "some-illiquid-token": { usd_market_cap: 100 }, // no `usd` key at all
      }),
    );

    const provider = new CoinGeckoProvider("test-key");
    const prices = await provider.getPrices(["ethereum", "some-illiquid-token"]);

    expect(prices).toHaveLength(1);
    expect(prices[0].id).toBe("ethereum");
  });

  it("defaults marketCap/volume24h/priceChange24h to null when absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ethereum: { usd: 4109.5 } }));
    const provider = new CoinGeckoProvider("test-key");
    const [price] = await provider.getPrices(["ethereum"]);
    expect(price.marketCap).toBeNull();
    expect(price.volume24h).toBeNull();
    expect(price.priceChange24h).toBeNull();
  });

  it("treats an explicit null usd_24h_change the same as an absent one", async () => {
    // CoinGecko sends a literal `null` (not just an omitted key) for tokens
    // without enough trailing-24h history - caught live via `npm run
    // sync:prices` returning a real batch containing exactly this shape.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ "hashnote-usyc": { usd: 1.05, usd_24h_change: null } }),
    );
    const provider = new CoinGeckoProvider("test-key");
    const [price] = await provider.getPrices(["hashnote-usyc"]);
    expect(price.priceChange24h).toBeNull();
  });

  it("includes the demo API key header when one is configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ethereum: { usd: 1 } }));
    const provider = new CoinGeckoProvider("my-demo-key");
    await provider.getPrices(["ethereum"]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["x-cg-demo-api-key"]).toBe("my-demo-key");
  });

  it("omits the API key header when none is configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ethereum: { usd: 1 } }));
    const provider = new CoinGeckoProvider(undefined);
    await provider.getPrices(["ethereum"]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["x-cg-demo-api-key"]).toBeUndefined();
  });

  it("splits requests into batches of 100 ids", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const provider = new CoinGeckoProvider("test-key");
    const ids = Array.from({ length: 150 }, (_, i) => `token-${i}`);
    await provider.getPrices(ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(new URL(firstUrl).searchParams.get("ids")?.split(",")).toHaveLength(100);
    expect(new URL(secondUrl).searchParams.get("ids")?.split(",")).toHaveLength(50);
  });

  describe("error handling", () => {
    it("throws a specific ProviderUnavailableError on 429 rate limiting", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }));
      const provider = new CoinGeckoProvider("test-key");
      await expect(provider.getPrices(["ethereum"])).rejects.toThrow(/rate limited/i);
    });

    it("throws ProviderUnavailableError on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
      const provider = new CoinGeckoProvider("test-key");
      await expect(provider.getPrices(["ethereum"])).rejects.toThrow(ProviderUnavailableError);
    });

    it("throws ProviderUnavailableError on a non-ok, non-429 status", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
      const provider = new CoinGeckoProvider("test-key");
      await expect(provider.getPrices(["ethereum"])).rejects.toThrow(ProviderUnavailableError);
    });

    it("throws ProviderUnavailableError when the response doesn't match the expected shape", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(["not", "a", "record"]));
      const provider = new CoinGeckoProvider("test-key");
      await expect(provider.getPrices(["ethereum"])).rejects.toThrow(ProviderUnavailableError);
    });
  });

  describe("getTopMarketTokens", () => {
    function mockMarketsAndList(markets: unknown[], list: unknown[]) {
      // getTopMarketTokens invokes fetch() for /coins/markets before
      // /coins/list (both synchronously, inside the Promise.all array), so
      // mockResolvedValueOnce queues in that same order regardless of which
      // response actually resolves first.
      fetchMock.mockResolvedValueOnce(jsonResponse(markets)).mockResolvedValueOnce(jsonResponse(list));
    }

    it("cross-references market data with platform contract addresses", async () => {
      mockMarketsAndList(
        [
          {
            id: "usd-coin",
            symbol: "usdc",
            name: "USD Coin",
            image: "https://example.com/usdc.png",
            current_price: 1.0,
            market_cap: 32_000_000_000,
            total_volume: 4_500_000_000,
          },
        ],
        [
          {
            id: "usd-coin",
            platforms: { ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "arbitrum-one": "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
          },
        ],
      );

      const provider = new CoinGeckoProvider("test-key");
      const [token] = await provider.getTopMarketTokens(250);

      expect(token.coingeckoId).toBe("usd-coin");
      expect(token.symbol).toBe("USDC");
      expect(token.priceUsd).toBe(1.0);
      expect(token.platforms.ethereum).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
      expect(token.platforms["arbitrum-one"]).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    });

    it("defaults platforms to {} when the coin is missing from /coins/list", async () => {
      mockMarketsAndList(
        [
          {
            id: "bitcoin",
            symbol: "btc",
            name: "Bitcoin",
            image: null,
            current_price: 60000,
            market_cap: 1_000_000_000_000,
            total_volume: 20_000_000_000,
          },
        ],
        [], // /coins/list didn't include this id
      );

      const provider = new CoinGeckoProvider("test-key");
      const [token] = await provider.getTopMarketTokens(250);

      expect(token.platforms).toEqual({});
      expect(token.logoUrl).toBeNull();
    });

    it("caps per_page at 250 even when a larger limit is requested", async () => {
      mockMarketsAndList([], []);
      const provider = new CoinGeckoProvider("test-key");
      await provider.getTopMarketTokens(1000);

      const marketsUrl = fetchMock.mock.calls[0][0] as string;
      expect(new URL(marketsUrl).searchParams.get("per_page")).toBe("250");
    });

    it("throws ProviderUnavailableError on an unexpected /coins/markets shape", async () => {
      mockMarketsAndList([{ id: "bad" }], []); // missing required fields
      const provider = new CoinGeckoProvider("test-key");
      await expect(provider.getTopMarketTokens(250)).rejects.toThrow(ProviderUnavailableError);
    });
  });
});
