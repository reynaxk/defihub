import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

  if (items.length === 0) return [];

  const protocolIds = items.map((i) => i.protocolId).filter((id) => id != null);
  const chainIds = items.map((i) => i.chainId).filter((id) => id != null);

  // Fixed number of queries regardless of watchlist size (previously N+1:
  // one pair of queries per item, in a loop). DISTINCT ON gets exactly the
  // latest row per id in one pass instead of pulling full history and
  // picking the first row client-side.
  const [protocolRows, protocolTvlRows, chainRows, chainTvlRows] = await Promise.all([
    protocolIds.length > 0 ? db.select().from(protocols).where(inArray(protocols.id, protocolIds)) : [],
    protocolIds.length > 0
      ? db
          .selectDistinctOn([protocolMetrics.protocolId], {
            protocolId: protocolMetrics.protocolId,
            tvl: protocolMetrics.tvl,
          })
          .from(protocolMetrics)
          .where(and(inArray(protocolMetrics.protocolId, protocolIds), isNull(protocolMetrics.chainId)))
          .orderBy(protocolMetrics.protocolId, desc(protocolMetrics.timestamp))
      : [],
    chainIds.length > 0 ? db.select().from(chains).where(inArray(chains.id, chainIds)) : [],
    chainIds.length > 0
      ? db
          .selectDistinctOn([chainMetrics.chainId], { chainId: chainMetrics.chainId, tvl: chainMetrics.tvl })
          .from(chainMetrics)
          .where(inArray(chainMetrics.chainId, chainIds))
          .orderBy(chainMetrics.chainId, desc(chainMetrics.timestamp))
      : [],
  ]);

  const protocolById = new Map(protocolRows.map((p) => [p.id, p]));
  const chainById = new Map(chainRows.map((c) => [c.id, c]));
  const protocolTvlById = new Map(protocolTvlRows.map((r) => [r.protocolId, r.tvl != null ? Number(r.tvl) : null]));
  const chainTvlById = new Map(chainTvlRows.map((r) => [r.chainId, r.tvl != null ? Number(r.tvl) : null]));

  const entries: WatchlistEntry[] = [];
  for (const item of items) {
    if (item.protocolId) {
      const protocol = protocolById.get(item.protocolId);
      if (!protocol) continue;
      entries.push({
        id: item.id,
        kind: "protocol",
        name: protocol.name,
        slug: protocol.slug,
        logoUrl: protocol.logoUrl,
        tvl: protocolTvlById.get(item.protocolId) ?? null,
      });
    } else if (item.chainId) {
      const chain = chainById.get(item.chainId);
      if (!chain) continue;
      entries.push({
        id: item.id,
        kind: "chain",
        name: chain.name,
        slug: chain.slug,
        logoUrl: chain.logoUrl,
        tvl: chainTvlById.get(item.chainId) ?? null,
      });
    }
  }

  return entries;
}
