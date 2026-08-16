import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefiLlamaProvider } from "./defillama";
import { ProviderUnavailableError } from "./types";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

describe("DefiLlamaProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getProtocols", () => {
    it("normalizes a real-shaped /protocols response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            slug: "lido",
            name: "Lido",
            description: null,
            url: "https://lido.fi",
            logo: "https://icons.llamao.fi/icons/protocols/lido",
            category: "Liquid Staking",
            chains: ["Ethereum"],
            tvl: 17_880_000_000,
            chainTvls: { Ethereum: 17_880_000_000 },
          },
        ]),
      );

      const provider = new DefiLlamaProvider();
      const protocols = await provider.getProtocols();

      expect(protocols).toEqual([
        {
          externalId: "lido",
          name: "Lido",
          slug: "lido",
          description: null,
          website: "https://lido.fi",
          logoUrl: "https://icons.llamao.fi/icons/protocols/lido",
          category: "Liquid Staking",
          chains: ["Ethereum"],
          tvl: 17_880_000_000,
          tvlByChain: { Ethereum: 17_880_000_000 },
        },
      ]);
    });

    it("defaults missing optional fields to null/empty rather than throwing", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ slug: "unknown-protocol", name: "Unknown Protocol" }]),
      );

      const provider = new DefiLlamaProvider();
      const [protocol] = await provider.getProtocols();

      expect(protocol.description).toBeNull();
      expect(protocol.website).toBeNull();
      expect(protocol.logoUrl).toBeNull();
      expect(protocol.category).toBeNull();
      expect(protocol.tvl).toBeNull();
      expect(protocol.chains).toEqual([]);
      expect(protocol.tvlByChain).toEqual({});
    });
  });

  describe("getProtocolFees", () => {
    it("merges fees and revenue by slug", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ protocols: [{ slug: "lido", total24h: 73_075 }, { slug: "aave-v3", total24h: 989_380 }] }),
        )
        .mockResolvedValueOnce(jsonResponse({ protocols: [{ slug: "lido", total24h: 7_307 }] }));

      const provider = new DefiLlamaProvider();
      const financials = await provider.getProtocolFees();

      expect(financials).toEqual([
        { externalId: "lido", fees24h: 73_075, revenue24h: 7_307, volume24h: null },
        { externalId: "aave-v3", fees24h: 989_380, revenue24h: null, volume24h: null },
      ]);
    });
  });

  describe("getProtocolVolume", () => {
    it("builds a slug -> volume map, skipping null totals", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          protocols: [
            { slug: "uniswap-v3", total24h: 1_200_000_000 },
            { slug: "some-dex-with-no-data", total24h: null },
          ],
        }),
      );

      const provider = new DefiLlamaProvider();
      const volume = await provider.getProtocolVolume();

      expect(volume.get("uniswap-v3")).toBe(1_200_000_000);
      expect(volume.has("some-dex-with-no-data")).toBe(false);
    });
  });

  describe("getChains", () => {
    it("normalizes chain rows, including non-EVM chains with a null chainId", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { gecko_id: "ethereum", tvl: 41_145_732_902.7, tokenSymbol: "ETH", cmcId: "1027", name: "Ethereum", chainId: 1 },
          { gecko_id: "solana", tvl: 4_803_879_068.9, tokenSymbol: "SOL", cmcId: "5426", name: "Solana", chainId: null },
        ]),
      );

      const provider = new DefiLlamaProvider();
      const chains = await provider.getChains();

      expect(chains).toEqual([
        { name: "Ethereum", tvl: 41_145_732_902.7, tokenSymbol: "ETH", chainId: 1 },
        { name: "Solana", tvl: 4_803_879_068.9, tokenSymbol: "SOL", chainId: null },
      ]);
    });
  });

  describe("getChainTvlHistory", () => {
    it("converts unix-seconds timestamps to Date objects", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ date: 1_506_470_400, tvl: 0 }, { date: 1_755_302_400, tvl: 41_109_938_199 }]));

      const provider = new DefiLlamaProvider();
      const history = await provider.getChainTvlHistory("Ethereum");

      expect(history[0].timestamp).toEqual(new Date(1_506_470_400 * 1000));
      expect(history[0].tvl).toBe(0);
      expect(history[1].tvl).toBe(41_109_938_199);
    });

    it("URL-encodes the chain name", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const provider = new DefiLlamaProvider();
      await provider.getChainTvlHistory("BNB Chain");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v2/historicalChainTvl/BNB%20Chain"),
        expect.anything(),
      );
    });
  });

  describe("getYieldPools", () => {
    it("normalizes a real-shaped yields.llama.fi pool", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          data: [
            {
              chain: "Ethereum",
              project: "lido",
              symbol: "STETH",
              tvlUsd: 17_863_335_831,
              apyBase: 2.144,
              apyReward: null,
              apy: 2.144,
              pool: "747c1d2a-c668-4682-b9f9-296708a3dd90",
              stablecoin: false,
              ilRisk: "no",
              underlyingTokens: ["0x0000000000000000000000000000000000000000"],
            },
          ],
        }),
      );

      const provider = new DefiLlamaProvider();
      const [pool] = await provider.getYieldPools();

      expect(pool).toEqual({
        externalPoolId: "747c1d2a-c668-4682-b9f9-296708a3dd90",
        protocolExternalSlug: "lido",
        chain: "Ethereum",
        symbol: "STETH",
        underlyingTokens: ["0x0000000000000000000000000000000000000000"],
        apy: 2.144,
        apyBase: 2.144,
        apyReward: null,
        tvlUsd: 17_863_335_831,
        stablecoin: false,
        ilRisk: "no",
      });
    });
  });

  describe("error handling", () => {
    it("throws ProviderUnavailableError on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const provider = new DefiLlamaProvider();
      await expect(provider.getProtocols()).rejects.toThrow(ProviderUnavailableError);
    });

    it("throws ProviderUnavailableError on a non-ok HTTP status", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));
      const provider = new DefiLlamaProvider();
      await expect(provider.getProtocols()).rejects.toThrow(ProviderUnavailableError);
    });

    it("throws ProviderUnavailableError when the response doesn't match the expected shape", async () => {
      // Missing required fields (name) - a provider API change we should
      // fail loudly on, not silently pass through malformed data.
      fetchMock.mockResolvedValueOnce(jsonResponse([{ slug: "x" }, "not even an object"]));
      const provider = new DefiLlamaProvider();
      await expect(provider.getProtocols()).rejects.toThrow(ProviderUnavailableError);
    });
  });
});
