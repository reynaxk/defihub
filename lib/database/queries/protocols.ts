import { and, count, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocolChains, protocolMetrics, protocols } from "@/lib/database/schema";

// All protocols get upserted with the same `timestamp` value within a single
// sync run, so "the most recent sync's rows" is just "rows at MAX(timestamp)"
// - simpler and just as correct as a DISTINCT ON per protocol at this scale.
const latestAggregateTimestamp = db
  .select({ ts: sql<Date>`max(${protocolMetrics.timestamp})`.as("ts") })
  .from(protocolMetrics)
  .where(isNull(protocolMetrics.chainId))
  .as("latest_ts");

export interface ProtocolListItem {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  category: string | null;
  tvl: number | null;
  volume24h: number | null;
  fees24h: number | null;
  revenue24h: number | null;
}

export async function getTopProtocols(limit = 100): Promise<ProtocolListItem[]> {
  const rows = await db
    .select({
      id: protocols.id,
      name: protocols.name,
      slug: protocols.slug,
      logoUrl: protocols.logoUrl,
      category: protocols.category,
      tvl: protocolMetrics.tvl,
      volume24h: protocolMetrics.volume24h,
      fees24h: protocolMetrics.fees24h,
      revenue24h: protocolMetrics.revenue24h,
    })
    .from(protocolMetrics)
    .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .where(isNull(protocolMetrics.chainId))
    .orderBy(desc(protocolMetrics.tvl))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    tvl: r.tvl != null ? Number(r.tvl) : null,
    volume24h: r.volume24h != null ? Number(r.volume24h) : null,
    fees24h: r.fees24h != null ? Number(r.fees24h) : null,
    revenue24h: r.revenue24h != null ? Number(r.revenue24h) : null,
  }));
}

export interface ProtocolFilters {
  category?: string;
  chainSlug?: string;
  search?: string;
}

export async function getProtocolsList(filters: ProtocolFilters = {}): Promise<ProtocolListItem[]> {
  const conditions = [isNull(protocolMetrics.chainId)];
  if (filters.category) conditions.push(eq(protocols.category, filters.category));
  if (filters.search) conditions.push(ilike(protocols.name, `%${filters.search}%`));

  let query = db
    .select({
      id: protocols.id,
      name: protocols.name,
      slug: protocols.slug,
      logoUrl: protocols.logoUrl,
      category: protocols.category,
      tvl: protocolMetrics.tvl,
      volume24h: protocolMetrics.volume24h,
      fees24h: protocolMetrics.fees24h,
      revenue24h: protocolMetrics.revenue24h,
    })
    .from(protocolMetrics)
    .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .$dynamic();

  if (filters.chainSlug) {
    query = query
      .innerJoin(protocolChains, eq(protocolChains.protocolId, protocols.id))
      .innerJoin(chains, eq(chains.id, protocolChains.chainId));
    conditions.push(eq(chains.slug, filters.chainSlug));
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(desc(protocolMetrics.tvl))
    .limit(500);

  // chain filter can join-duplicate rows (a protocol can be on multiple
  // matching chains via the extra join); de-dupe by protocol id.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

  return deduped.map((r) => ({
    ...r,
    tvl: r.tvl != null ? Number(r.tvl) : null,
    volume24h: r.volume24h != null ? Number(r.volume24h) : null,
    fees24h: r.fees24h != null ? Number(r.fees24h) : null,
    revenue24h: r.revenue24h != null ? Number(r.revenue24h) : null,
  }));
}

export async function getProtocolCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(protocols);
  return row?.value ?? 0;
}

export async function getAllCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: protocols.category })
    .from(protocols)
    .where(sql`${protocols.category} is not null`)
    .orderBy(protocols.category);
  return rows.map((r) => r.category as string).filter(Boolean);
}

export async function getProtocolBySlug(slug: string) {
  const [protocol] = await db.select().from(protocols).where(eq(protocols.slug, slug));
  if (!protocol) return null;

  const chainLinks = await db
    .select({ chain: chains })
    .from(protocolChains)
    .innerJoin(chains, eq(chains.id, protocolChains.chainId))
    .where(eq(protocolChains.protocolId, protocol.id));

  const history = await db
    .select({
      timestamp: protocolMetrics.timestamp,
      tvl: protocolMetrics.tvl,
      volume24h: protocolMetrics.volume24h,
      fees24h: protocolMetrics.fees24h,
      revenue24h: protocolMetrics.revenue24h,
    })
    .from(protocolMetrics)
    .where(and(eq(protocolMetrics.protocolId, protocol.id), isNull(protocolMetrics.chainId)))
    .orderBy(protocolMetrics.timestamp);

  const normalizedHistory = history.map((h) => ({
    timestamp: h.timestamp,
    tvl: h.tvl != null ? Number(h.tvl) : null,
    volume24h: h.volume24h != null ? Number(h.volume24h) : null,
    fees24h: h.fees24h != null ? Number(h.fees24h) : null,
    revenue24h: h.revenue24h != null ? Number(h.revenue24h) : null,
  }));

  return {
    protocol,
    chains: chainLinks.map((c) => c.chain),
    history: normalizedHistory,
    latest: normalizedHistory.length > 0 ? normalizedHistory[normalizedHistory.length - 1] : null,
  };
}
