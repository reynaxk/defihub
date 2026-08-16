import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols } from "@/lib/database/schema";

export interface ChainListItem {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  nativeToken: string;
  tvl: number | null;
}

export async function getTopChains(): Promise<ChainListItem[]> {
  const latestPerChain = db
    .select({
      chainId: chainMetrics.chainId,
      ts: sql<Date>`max(${chainMetrics.timestamp})`.as("ts"),
    })
    .from(chainMetrics)
    .groupBy(chainMetrics.chainId)
    .as("latest_per_chain");

  const rows = await db
    .select({
      id: chains.id,
      name: chains.name,
      slug: chains.slug,
      logoUrl: chains.logoUrl,
      nativeToken: chains.nativeToken,
      tvl: chainMetrics.tvl,
    })
    .from(chains)
    .leftJoin(latestPerChain, eq(latestPerChain.chainId, chains.id))
    .leftJoin(
      chainMetrics,
      sql`${chainMetrics.chainId} = ${latestPerChain.chainId} and ${chainMetrics.timestamp} = ${latestPerChain.ts}`,
    )
    .orderBy(desc(chainMetrics.tvl));

  return rows.map((r) => ({ ...r, tvl: r.tvl != null ? Number(r.tvl) : null }));
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
          })
          .from(protocolMetrics)
          .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
          .where(sql`${protocolMetrics.chainId} = ${chain.id} and ${protocolMetrics.timestamp} = ${latestTs[0].ts}`)
          .orderBy(desc(protocolMetrics.tvl))
          .limit(50)
      : [];

  return {
    chain,
    history: history.map((h) => ({ timestamp: h.timestamp, tvl: h.tvl != null ? Number(h.tvl) : null })),
    topProtocols: topProtocols.map((p) => ({
      ...p,
      tvl: p.tvl != null ? Number(p.tvl) : null,
      volume24h: null,
      fees24h: null,
      revenue24h: null,
    })),
    latestTvl: history.length > 0 ? Number(history[history.length - 1].tvl ?? 0) : null,
  };
}

export async function getAllChains() {
  return db.select().from(chains).orderBy(chains.name);
}
