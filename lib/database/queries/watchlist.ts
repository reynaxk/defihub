import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols, watchlist } from "@/lib/database/schema";

export async function isWatchingProtocol(userId: string | undefined, protocolId: string): Promise<boolean> {
  if (!userId) return false;
  const rows = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.protocolId, protocolId)));
  return rows.length > 0;
}

export async function isWatchingChain(userId: string | undefined, chainId: string): Promise<boolean> {
  if (!userId) return false;
  const rows = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.chainId, chainId)));
  return rows.length > 0;
}

export interface WatchlistEntry {
  id: string;
  kind: "protocol" | "chain";
  name: string;
  slug: string;
  logoUrl: string | null;
  tvl: number | null;
}

export async function getWatchlistWithDetails(userId: string): Promise<WatchlistEntry[]> {
  const items = await db
    .select()
    .from(watchlist)
    .where(eq(watchlist.userId, userId))
    .orderBy(desc(watchlist.createdAt));

  const entries: WatchlistEntry[] = [];

  for (const item of items) {
    if (item.protocolId) {
      const [protocol] = await db.select().from(protocols).where(eq(protocols.id, item.protocolId));
      if (!protocol) continue;
      const [latest] = await db
        .select({ tvl: protocolMetrics.tvl })
        .from(protocolMetrics)
        .where(and(eq(protocolMetrics.protocolId, protocol.id), isNull(protocolMetrics.chainId)))
        .orderBy(desc(protocolMetrics.timestamp))
        .limit(1);
      entries.push({
        id: item.id,
        kind: "protocol",
        name: protocol.name,
        slug: protocol.slug,
        logoUrl: protocol.logoUrl,
        tvl: latest?.tvl != null ? Number(latest.tvl) : null,
      });
    } else if (item.chainId) {
      const [chain] = await db.select().from(chains).where(eq(chains.id, item.chainId));
      if (!chain) continue;
      const [latest] = await db
        .select({ tvl: chainMetrics.tvl })
        .from(chainMetrics)
        .where(eq(chainMetrics.chainId, chain.id))
        .orderBy(desc(chainMetrics.timestamp))
        .limit(1);
      entries.push({
        id: item.id,
        kind: "chain",
        name: chain.name,
        slug: chain.slug,
        logoUrl: chain.logoUrl,
        tvl: latest?.tvl != null ? Number(latest.tvl) : null,
      });
    }
  }

  return entries;
}
