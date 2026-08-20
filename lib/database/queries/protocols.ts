import { and, count, desc, eq, ilike, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocolChains, protocolMetrics, protocols } from "@/lib/database/schema";
import { normalizePagination, totalPages as computeTotalPages } from "@/lib/database/pagination";
import { escapeLikePattern } from "@/lib/utils/like-pattern";

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
  tvlChange1d: number | null;
  tvlChange7d: number | null;
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
      tvlChange1d: protocolMetrics.tvlChange1d,
      tvlChange7d: protocolMetrics.tvlChange7d,
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
    tvlChange1d: r.tvlChange1d != null ? Number(r.tvlChange1d) : null,
    tvlChange7d: r.tvlChange7d != null ? Number(r.tvlChange7d) : null,
  }));
}

export type ProtocolSort = "tvl" | "change1d" | "change7d" | "fees" | "revenue" | "volume";

export interface ProtocolFilters {
  category?: string;
  chainSlug?: string;
  search?: string;
  sortBy?: ProtocolSort;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

function protocolSortColumn(sortBy: ProtocolSort | undefined) {
  switch (sortBy) {
    case "change1d":
      return protocolMetrics.tvlChange1d;
    case "change7d":
      return protocolMetrics.tvlChange7d;
    case "fees":
      return protocolMetrics.fees24h;
    case "revenue":
      return protocolMetrics.revenue24h;
    case "volume":
      return protocolMetrics.volume24h;
    default:
      return protocolMetrics.tvl;
  }
}

export interface PaginatedProtocols {
  items: ProtocolListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function getProtocolsList(filters: ProtocolFilters = {}): Promise<PaginatedProtocols> {
  const { page, pageSize } = normalizePagination(filters);

  const conditions = [isNull(protocolMetrics.chainId)];
  if (filters.category) conditions.push(eq(protocols.category, filters.category));
  if (filters.search) conditions.push(ilike(protocols.name, `%${escapeLikePattern(filters.search)}%`));

  let itemsQuery = db
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
      tvlChange1d: protocolMetrics.tvlChange1d,
      tvlChange7d: protocolMetrics.tvlChange7d,
    })
    .from(protocolMetrics)
    .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .$dynamic();

  let countQuery = db
    .select({ value: count() })
    .from(protocolMetrics)
    .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .$dynamic();

  if (filters.chainSlug) {
    // A single chain slug can join at most one protocol_chains row per
    // protocol (protocol_id, chain_id) is a composite PK, so this never
    // multiplies rows - no de-dupe needed after the fact.
    itemsQuery = itemsQuery
      .innerJoin(protocolChains, eq(protocolChains.protocolId, protocols.id))
      .innerJoin(chains, eq(chains.id, protocolChains.chainId));
    countQuery = countQuery
      .innerJoin(protocolChains, eq(protocolChains.protocolId, protocols.id))
      .innerJoin(chains, eq(chains.id, protocolChains.chainId));
    conditions.push(eq(chains.slug, filters.chainSlug));
  }

  const sortColumn = protocolSortColumn(filters.sortBy);
  const sortDir = filters.sortDir === "asc" ? sql`asc` : sql`desc`;

  // Count first, then clamp the requested page to what actually exists,
  // before computing the offset - normalizePagination only floors/defaults
  // page, it can't clamp to totalPages since total isn't known yet at that
  // point. Without this, an out-of-range page (stale bookmark after the
  // underlying data set shrinks, or a hand-edited URL) would offset past
  // every real row, and the caller's "Showing X-Y of Z" display math (built
  // from this same returned `page`) would report a range that doesn't
  // match the (empty) items actually returned.
  const countRows = await countQuery.where(and(...conditions));
  const total = countRows[0]?.value ?? 0;
  const clampedPage = Math.min(page, computeTotalPages(total, pageSize));

  const rows = await itemsQuery
    .where(and(...conditions))
    // A secondary sort key on the primary key is required for stable
    // pagination: Postgres doesn't guarantee tie order otherwise, and
    // ties are common here (tvlChange1d/7d, fees24h, revenue24h are
    // frequently null or 0 for many protocols) - without this, the same
    // row can appear on two different pages, or get skipped, purely from
    // how a given LIMIT/OFFSET happens to land within a tied group.
    .orderBy(sql`${sortColumn} ${sortDir} nulls last`, protocols.id)
    .limit(pageSize)
    .offset((clampedPage - 1) * pageSize);

  return {
    items: rows.map((r) => ({
      ...r,
      tvl: r.tvl != null ? Number(r.tvl) : null,
      volume24h: r.volume24h != null ? Number(r.volume24h) : null,
      fees24h: r.fees24h != null ? Number(r.fees24h) : null,
      revenue24h: r.revenue24h != null ? Number(r.revenue24h) : null,
      tvlChange1d: r.tvlChange1d != null ? Number(r.tvlChange1d) : null,
      tvlChange7d: r.tvlChange7d != null ? Number(r.tvlChange7d) : null,
    })),
    page: clampedPage,
    pageSize,
    total,
    totalPages: computeTotalPages(total, pageSize),
  };
}

// CSV export wants every row matching the active filters, not one page of
// them - getProtocolsList's pageSize is clamped to 100 (shared with the
// public API, where that cap is load-bearing), so this mirrors its
// filtering logic without pagination instead of trying to bypass that cap.
// EXPORT_MAX_ROWS is a defense-in-depth ceiling, not a expected limit -
// the real protocol count (~3000) sits comfortably under it.
const EXPORT_MAX_ROWS = 5000;

export async function getProtocolsForExport(
  filters: Pick<ProtocolFilters, "category" | "chainSlug" | "search"> = {},
): Promise<ProtocolListItem[]> {
  const conditions = [isNull(protocolMetrics.chainId)];
  if (filters.category) conditions.push(eq(protocols.category, filters.category));
  if (filters.search) conditions.push(ilike(protocols.name, `%${escapeLikePattern(filters.search)}%`));

  let itemsQuery = db
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
      tvlChange1d: protocolMetrics.tvlChange1d,
      tvlChange7d: protocolMetrics.tvlChange7d,
    })
    .from(protocolMetrics)
    .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .$dynamic();

  if (filters.chainSlug) {
    itemsQuery = itemsQuery
      .innerJoin(protocolChains, eq(protocolChains.protocolId, protocols.id))
      .innerJoin(chains, eq(chains.id, protocolChains.chainId));
    conditions.push(eq(chains.slug, filters.chainSlug));
  }

  const rows = await itemsQuery
    .where(and(...conditions))
    .orderBy(desc(protocolMetrics.tvl))
    .limit(EXPORT_MAX_ROWS);

  return rows.map((r) => ({
    ...r,
    tvl: r.tvl != null ? Number(r.tvl) : null,
    volume24h: r.volume24h != null ? Number(r.volume24h) : null,
    fees24h: r.fees24h != null ? Number(r.fees24h) : null,
    revenue24h: r.revenue24h != null ? Number(r.revenue24h) : null,
    tvlChange1d: r.tvlChange1d != null ? Number(r.tvlChange1d) : null,
    tvlChange7d: r.tvlChange7d != null ? Number(r.tvlChange7d) : null,
  }));
}

export async function getProtocolCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(protocols);
  return row?.value ?? 0;
}

export interface Global24hTotals {
  volume24h: number | null;
  fees24h: number | null;
  revenue24h: number | null;
}

// Sums each protocol's own 24h figures at the latest sync - a real total
// built from the same per-protocol numbers shown elsewhere in the app, not
// a separately-fetched "global" figure that could silently drift from them.
export async function getGlobal24hTotals(): Promise<Global24hTotals> {
  const [row] = await db
    .select({
      volume24h: sql<string | null>`sum(${protocolMetrics.volume24h})`,
      fees24h: sql<string | null>`sum(${protocolMetrics.fees24h})`,
      revenue24h: sql<string | null>`sum(${protocolMetrics.revenue24h})`,
    })
    .from(protocolMetrics)
    .innerJoin(latestAggregateTimestamp, eq(protocolMetrics.timestamp, latestAggregateTimestamp.ts))
    .where(isNull(protocolMetrics.chainId));

  return {
    volume24h: row?.volume24h != null ? Number(row.volume24h) : null,
    fees24h: row?.fees24h != null ? Number(row.fees24h) : null,
    revenue24h: row?.revenue24h != null ? Number(row.revenue24h) : null,
  };
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
      tvlChange1d: protocolMetrics.tvlChange1d,
      tvlChange7d: protocolMetrics.tvlChange7d,
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
    tvlChange1d: h.tvlChange1d != null ? Number(h.tvlChange1d) : null,
    tvlChange7d: h.tvlChange7d != null ? Number(h.tvlChange7d) : null,
  }));

  return {
    protocol,
    chains: chainLinks.map((c) => c.chain),
    history: normalizedHistory,
    latest: normalizedHistory.length > 0 ? normalizedHistory[normalizedHistory.length - 1] : null,
  };
}

export interface ProtocolChainBreakdownItem {
  chainName: string;
  chainSlug: string;
  chainLogoUrl: string | null;
  tvl: number | null;
}

// Per-chain TVL rows share the same sync-run timestamp as the protocol's
// aggregate row (both written in one pass by workers/protocols/sync.ts), so
// "latest per-chain breakdown" is just "chain-scoped rows at the protocol's
// most recent timestamp" - no separate latest-per-chain logic needed.
export async function getProtocolChainBreakdown(protocolId: string): Promise<ProtocolChainBreakdownItem[]> {
  const [latestTs] = await db
    .select({ ts: sql<Date>`max(${protocolMetrics.timestamp})`.as("ts") })
    .from(protocolMetrics)
    .where(and(eq(protocolMetrics.protocolId, protocolId), isNotNull(protocolMetrics.chainId)));

  if (!latestTs?.ts) return [];

  // A raw sql<Date> aggregate result comes back from the postgres driver as
  // a string despite the type hint (same gotcha as getGlobalTvlHistory) -
  // coerce before using it in a typed timestamp comparison below, or
  // drizzle's PgTimestamp serializer throws trying to call .toISOString()
  // on a string.
  const latestTimestamp = new Date(latestTs.ts);

  const rows = await db
    .select({
      chainName: chains.name,
      chainSlug: chains.slug,
      chainLogoUrl: chains.logoUrl,
      tvl: protocolMetrics.tvl,
    })
    .from(protocolMetrics)
    .innerJoin(chains, eq(chains.id, protocolMetrics.chainId))
    .where(and(eq(protocolMetrics.protocolId, protocolId), eq(protocolMetrics.timestamp, latestTimestamp)))
    .orderBy(desc(protocolMetrics.tvl));

  return rows.map((r) => ({ ...r, tvl: r.tvl != null ? Number(r.tvl) : null }));
}
