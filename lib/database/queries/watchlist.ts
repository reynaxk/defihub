import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/database/client";
import {
  chainMetrics,
  chains,
  protocolMetrics,
  protocols,
  tokenPrices,
  tokens,
  watchlist,
  yieldPools,
} from "@/lib/database/schema";

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

export async function isWatchingToken(userId: string | undefined, tokenId: string): Promise<boolean> {
  if (!userId) return false;
  const rows = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.tokenId, tokenId)));
  return rows.length > 0;
}

export async function isWatchingPool(userId: string | undefined, yieldPoolId: string): Promise<boolean> {
  if (!userId) return false;
  const rows = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.yieldPoolId, yieldPoolId)));
  return rows.length > 0;
}

// Batched form for a list of pools (e.g. a whole yields table) - one query
// instead of one isWatchingPool() call per row.
export async function getWatchedPoolIds(userId: string | undefined, poolIds: string[]): Promise<Set<string>> {
  if (!userId || poolIds.length === 0) return new Set();
  const rows = await db
    .select({ yieldPoolId: watchlist.yieldPoolId })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), inArray(watchlist.yieldPoolId, poolIds)));
  return new Set(rows.map((r) => r.yieldPoolId).filter((id): id is string => id != null));
}

export interface WatchlistEntry {
  id: string;
  kind: "protocol" | "chain" | "token" | "pool";
  name: string;
  slug: string;
  logoUrl: string | null;
  tvl: number | null;
  // Token entries route to /token/[address]?chain=[chainSlug] instead of a
  // plain [slug] path - chainSlug is unused for protocol/chain kinds.
  chainSlug?: string;
  // Pools have no dedicated detail page - slug doubles as a /yields?q=
  // search term for pool entries, pointing at the closest working deep link.
  apy?: number | null;
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
  const tokenIds = items.map((i) => i.tokenId).filter((id) => id != null);
  const poolIds = items.map((i) => i.yieldPoolId).filter((id) => id != null);

  // Fixed number of queries regardless of watchlist size (previously N+1:
  // one pair of queries per item, in a loop). DISTINCT ON gets exactly the
  // latest row per id in one pass instead of pulling full history and
  // picking the first row client-side.
  const [protocolRows, protocolTvlRows, chainRows, chainTvlRows, tokenRows, tokenPriceRows, poolRows] = await Promise.all([
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
    tokenIds.length > 0
      ? db
          .select({ token: tokens, chainSlug: chains.slug })
          .from(tokens)
          .innerJoin(chains, eq(chains.id, tokens.chainId))
          .where(inArray(tokens.id, tokenIds))
      : [],
    tokenIds.length > 0
      ? db
          .selectDistinctOn([tokenPrices.tokenId], { tokenId: tokenPrices.tokenId, marketCap: tokenPrices.marketCap })
          .from(tokenPrices)
          .where(inArray(tokenPrices.tokenId, tokenIds))
          .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp))
      : [],
    poolIds.length > 0
      ? db
          .select({
            id: yieldPools.id,
            symbol: yieldPools.symbol,
            apy: yieldPools.apy,
            tvlUsd: yieldPools.tvlUsd,
            logoUrl: protocols.logoUrl,
          })
          .from(yieldPools)
          .leftJoin(protocols, eq(protocols.id, yieldPools.protocolId))
          .where(inArray(yieldPools.id, poolIds))
      : [],
  ]);

  const protocolById = new Map(protocolRows.map((p) => [p.id, p]));
  const chainById = new Map(chainRows.map((c) => [c.id, c]));
  const tokenById = new Map(tokenRows.map((r) => [r.token.id, r]));
  const poolById = new Map(poolRows.map((r) => [r.id, r]));
  const protocolTvlById = new Map(protocolTvlRows.map((r) => [r.protocolId, r.tvl != null ? Number(r.tvl) : null]));
  const chainTvlById = new Map(chainTvlRows.map((r) => [r.chainId, r.tvl != null ? Number(r.tvl) : null]));
  const tokenMarketCapById = new Map(
    tokenPriceRows.map((r) => [r.tokenId, r.marketCap != null ? Number(r.marketCap) : null]),
  );

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
    } else if (item.tokenId) {
      const row = tokenById.get(item.tokenId);
      if (!row) continue;
      entries.push({
        id: item.id,
        kind: "token",
        name: row.token.symbol,
        slug: row.token.address,
        logoUrl: row.token.logoUrl,
        tvl: tokenMarketCapById.get(item.tokenId) ?? null,
        chainSlug: row.chainSlug,
      });
    } else if (item.yieldPoolId) {
      const pool = poolById.get(item.yieldPoolId);
      if (!pool) continue;
      entries.push({
        id: item.id,
        kind: "pool",
        name: pool.symbol,
        slug: pool.symbol,
        logoUrl: pool.logoUrl,
        tvl: pool.tvlUsd != null ? Number(pool.tvlUsd) : null,
        apy: pool.apy != null ? Number(pool.apy) : null,
      });
    }
  }

  return entries;
}
