import { z } from "zod";
import type {
  ChainTvlPoint,
  DefiDataProvider,
  NormalizedChain,
  NormalizedProtocol,
  NormalizedProtocolFinancials,
  NormalizedYieldPool,
} from "./types";
import { ProviderUnavailableError } from "./types";

const BASE_URL = "https://api.llama.fi";
const YIELDS_BASE_URL = "https://yields.llama.fi";

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ProviderUnavailableError("defillama", `network error fetching ${url}`, cause);
  }
  if (!res.ok) {
    throw new ProviderUnavailableError("defillama", `${res.status} ${res.statusText} from ${url}`);
  }
  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderUnavailableError(
      "defillama",
      `unexpected response shape from ${url}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// /protocols
// ---------------------------------------------------------------------------

const protocolSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  logo: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  chains: z.array(z.string()).default([]),
  tvl: z.number().nullable().optional(),
  chainTvls: z.record(z.string(), z.number()).default({}),
  change_1d: z.number().nullable().optional(),
  change_7d: z.number().nullable().optional(),
});

const protocolsResponseSchema = z.array(protocolSchema);

function toNormalizedProtocol(p: z.infer<typeof protocolSchema>): NormalizedProtocol {
  return {
    externalId: p.slug,
    name: p.name,
    slug: p.slug,
    description: p.description ?? null,
    website: p.url ?? null,
    logoUrl: p.logo ?? null,
    category: p.category ?? null,
    chains: p.chains,
    tvl: p.tvl ?? null,
    tvlByChain: p.chainTvls,
    tvlChange1d: p.change_1d ?? null,
    tvlChange7d: p.change_7d ?? null,
  };
}

// ---------------------------------------------------------------------------
// /overview/fees, /overview/fees?dataType=dailyRevenue, /overview/dexs
// ---------------------------------------------------------------------------

const overviewProtocolSchema = z.object({
  slug: z.string(),
  total24h: z.number().nullable().optional(),
});

const overviewResponseSchema = z.object({
  protocols: z.array(overviewProtocolSchema),
});

function overviewUrl(kind: "fees" | "dexs", dataType?: string) {
  const params = new URLSearchParams({
    excludeTotalDataChart: "true",
    excludeTotalDataChartBreakdown: "true",
  });
  if (dataType) params.set("dataType", dataType);
  return `${BASE_URL}/overview/${kind}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// /v2/chains, /v2/historicalChainTvl/{chain}
// ---------------------------------------------------------------------------

const chainSchema = z.object({
  name: z.string(),
  tvl: z.number(),
  tokenSymbol: z.string().nullable().optional(),
  chainId: z.number().nullable().optional(),
});

const chainsResponseSchema = z.array(chainSchema);

const chainTvlPointSchema = z.object({
  date: z.number(),
  tvl: z.number(),
});

const chainTvlHistoryResponseSchema = z.array(chainTvlPointSchema);

// ---------------------------------------------------------------------------
// yields.llama.fi/pools
// ---------------------------------------------------------------------------

const yieldPoolSchema = z.object({
  pool: z.string(),
  project: z.string().nullable().optional(),
  chain: z.string(),
  symbol: z.string(),
  underlyingTokens: z.array(z.string()).nullable().optional(),
  apy: z.number().nullable().optional(),
  apyBase: z.number().nullable().optional(),
  apyReward: z.number().nullable().optional(),
  tvlUsd: z.number().nullable().optional(),
  stablecoin: z.boolean().default(false),
  ilRisk: z.string().nullable().optional(),
});

const yieldPoolsResponseSchema = z.object({
  status: z.string().optional(),
  data: z.array(yieldPoolSchema),
});

export class DefiLlamaProvider implements DefiDataProvider {
  async getProtocols(): Promise<NormalizedProtocol[]> {
    const protocols = await fetchJson(`${BASE_URL}/protocols`, protocolsResponseSchema);
    return protocols.map(toNormalizedProtocol);
  }

  async getProtocolFees(): Promise<NormalizedProtocolFinancials[]> {
    const [fees, revenue] = await Promise.all([
      fetchJson(overviewUrl("fees"), overviewResponseSchema),
      fetchJson(overviewUrl("fees", "dailyRevenue"), overviewResponseSchema),
    ]);

    const revenueBySlug = new Map(revenue.protocols.map((p) => [p.slug, p.total24h ?? null]));

    return fees.protocols.map((p) => ({
      externalId: p.slug,
      fees24h: p.total24h ?? null,
      revenue24h: revenueBySlug.get(p.slug) ?? null,
      volume24h: null,
    }));
  }

  async getProtocolVolume(): Promise<Map<string, number>> {
    const dexs = await fetchJson(overviewUrl("dexs", "dailyVolume"), overviewResponseSchema);
    const result = new Map<string, number>();
    for (const p of dexs.protocols) {
      if (p.total24h != null) result.set(p.slug, p.total24h);
    }
    return result;
  }

  async getChains(): Promise<NormalizedChain[]> {
    const chains = await fetchJson(`${BASE_URL}/v2/chains`, chainsResponseSchema);
    return chains.map((c) => ({
      name: c.name,
      tvl: c.tvl,
      tokenSymbol: c.tokenSymbol ?? null,
      chainId: c.chainId ?? null,
    }));
  }

  async getChainTvlHistory(chainName: string): Promise<ChainTvlPoint[]> {
    const history = await fetchJson(
      `${BASE_URL}/v2/historicalChainTvl/${encodeURIComponent(chainName)}`,
      chainTvlHistoryResponseSchema,
    );
    return history.map((point) => ({
      timestamp: new Date(point.date * 1000),
      tvl: point.tvl,
    }));
  }

  async getYieldPools(): Promise<NormalizedYieldPool[]> {
    const { data } = await fetchJson(`${YIELDS_BASE_URL}/pools`, yieldPoolsResponseSchema);
    return data.map((pool) => ({
      externalPoolId: pool.pool,
      protocolExternalSlug: pool.project ?? null,
      chain: pool.chain,
      symbol: pool.symbol,
      underlyingTokens: pool.underlyingTokens ?? [],
      apy: pool.apy ?? null,
      apyBase: pool.apyBase ?? null,
      apyReward: pool.apyReward ?? null,
      tvlUsd: pool.tvlUsd ?? null,
      stablecoin: pool.stablecoin,
      ilRisk: pool.ilRisk ?? null,
    }));
  }
}
