import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols } from "@/lib/database/schema";
import { computeTvlChanges, type TvlChanges } from "./tvl-change";

export interface ChainListItem {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  nativeToken: string;
  tvl: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
}

export async function getTopChains(): Promise<ChainListItem[]> {
  const chainRows = await db.select().from(chains);

  // Only ever 5-10 chains, each with a modest daily-point history - cheaper
  // and simpler to compute changes in JS from the full set than to express
  // "value at latest, 1d-ago, 7d-ago, 30d-ago" as one SQL query per chain.
  const allMetrics = await db
    .select({ chainId: chainMetrics.chainId, timestamp: chainMetrics.timestamp, tvl: chainMetrics.tvl })
    .from(chainMetrics)
    .orderBy(chainMetrics.timestamp);

  const byChain = new Map<string, { timestamp: Date; tvl: number | null }[]>();
  for (const m of allMetrics) {
    const list = byChain.get(m.chainId) ?? [];
    list.push({ timestamp: m.timestamp, tvl: m.tvl != null ? Number(m.tvl) : null });
    byChain.set(m.chainId, list);
  }

  const items = chainRows.map((chain) => {
    const changes = computeTvlChanges(byChain.get(chain.id) ?? []);
    return {
      id: chain.id,
      name: chain.name,
      slug: chain.slug,
      logoUrl: chain.logoUrl,
      nativeToken: chain.nativeToken,
      tvl: changes.latest,
      change24h: changes.change24h,
      change7d: changes.change7d,
      change30d: changes.change30d,
    };
  });

  return items.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
}

export async function getGlobalTvlHistory(): Promise<{ timestamp: Date; tvl: number }[]> {
  const rows = await db
    .select({
      day: sql<Date>`date_trunc('day', ${chainMetrics.timestamp})`.as("day"),
      tvl: sql<string>`sum(${chainMetrics.tvl})`.as("tvl"),
    })
    .from(chainMetrics)
    .groupBy(sql`date_trunc('day', ${chainMetrics.timestamp})`)
    .orderBy(sql`date_trunc('day', ${chainMetrics.timestamp})`);

  // `date_trunc` on a raw sql fragment comes back from the postgres driver
  // as a string, not a parsed Date, despite the sql<Date> type hint -
  // coerce explicitly rather than trusting that annotation at runtime.
  return rows.map((r) => ({ timestamp: new Date(r.day), tvl: Number(r.tvl) }));
}

export async function getGlobalTvlChanges(): Promise<TvlChanges> {
  const history = await getGlobalTvlHistory();
  return computeTvlChanges(history);
}

export async function getChainBySlug(slug: string) {
  const [chain] = await db.select().from(chains).where(eq(chains.slug, slug));
  if (!chain) return null;

  const history = await db
    .select({ timestamp: chainMetrics.timestamp, tvl: chainMetrics.tvl })
    .from(chainMetrics)
    .where(eq(chainMetrics.chainId, chain.id))
    .orderBy(chainMetrics.timestamp);

  const latestTs = await db
    .select({ ts: sql<Date>`max(${protocolMetrics.timestamp})`.as("ts") })
    .from(protocolMetrics)
    .where(eq(protocolMetrics.chainId, chain.id));

  const topProtocols =
    latestTs[0]?.ts != null
      ? await db
          .select({
            id: protocols.id,
            name: protocols.name,
            slug: protocols.slug,
            logoUrl: protocols.logoUrl,
            category: protocols.category,
            tvl: protocolMetrics.tvl,
            // Fees/volume/revenue are only tracked in aggregate (all-chains)
            // rows, not broken down per chain - null here is accurate, not
            // a bug: we simply don't have that per-chain figure.
            volume24h: sql<string | null>`null`,
            fees24h: sql<string | null>`null`,
            revenue24h: sql<string | null>`null`,
            tvlChange1d: sql<string | null>`null`,
            tvlChange7d: sql<string | null>`null`,
          })
          .from(protocolMetrics)
          .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
          .where(sql`${protocolMetrics.chainId} = ${chain.id} and ${protocolMetrics.timestamp} = ${latestTs[0].ts}`)
          .orderBy(desc(protocolMetrics.tvl))
          .limit(50)
      : [];

  const normalizedHistory = history.map((h) => ({
    timestamp: h.timestamp,
    tvl: h.tvl != null ? Number(h.tvl) : null,
  }));

  return {
    chain,
    history: normalizedHistory,
    topProtocols: topProtocols.map((p) => ({
      ...p,
      tvl: p.tvl != null ? Number(p.tvl) : null,
      volume24h: null,
      fees24h: null,
      revenue24h: null,
      tvlChange1d: null,
      tvlChange7d: null,
    })),
    latestTvl: normalizedHistory.length > 0 ? normalizedHistory[normalizedHistory.length - 1].tvl : null,
    changes: computeTvlChanges(normalizedHistory),
  };
}

export async function getAllChains() {
  return db.select().from(chains).orderBy(chains.name);
}
