import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocols, yieldPools } from "@/lib/database/schema";

export interface YieldFilters {
  chainSlug?: string;
  stablecoinOnly?: boolean;
  minApy?: number;
}

export async function getYieldPools(filters: YieldFilters = {}) {
  const conditions = [];
  if (filters.chainSlug) conditions.push(eq(chains.slug, filters.chainSlug));
  if (filters.stablecoinOnly) conditions.push(eq(yieldPools.stablecoin, true));
  if (filters.minApy != null) conditions.push(gte(yieldPools.apy, filters.minApy.toString()));

  const rows = await db
    .select({
      id: yieldPools.id,
      symbol: yieldPools.symbol,
      apy: yieldPools.apy,
      apyBase: yieldPools.apyBase,
      apyReward: yieldPools.apyReward,
      tvlUsd: yieldPools.tvlUsd,
      stablecoin: yieldPools.stablecoin,
      ilRisk: yieldPools.ilRisk,
      externalPoolId: yieldPools.externalPoolId,
      chainName: chains.name,
      chainSlug: chains.slug,
      chainLogoUrl: chains.logoUrl,
      protocolName: protocols.name,
      protocolSlug: protocols.slug,
      protocolLogoUrl: protocols.logoUrl,
    })
    .from(yieldPools)
    .innerJoin(chains, eq(chains.id, yieldPools.chainId))
    .leftJoin(protocols, eq(protocols.id, yieldPools.protocolId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(yieldPools.apy))
    .limit(300);

  return rows.map((r) => ({
    ...r,
    apy: r.apy != null ? Number(r.apy) : null,
    apyBase: r.apyBase != null ? Number(r.apyBase) : null,
    apyReward: r.apyReward != null ? Number(r.apyReward) : null,
    tvlUsd: r.tvlUsd != null ? Number(r.tvlUsd) : null,
  }));
}

export async function getYieldPoolCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(yieldPools);
  return row?.value ?? 0;
}
