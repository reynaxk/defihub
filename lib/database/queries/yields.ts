import { and, asc, count, desc, eq, gte, ilike, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocols, yieldPools } from "@/lib/database/schema";
import { normalizePagination, totalPages as computeTotalPages } from "@/lib/database/pagination";
import { escapeLikePattern } from "@/lib/utils/like-pattern";

export interface YieldFilters {
  chainSlug?: string;
  protocolSlug?: string;
  category?: string;
  stablecoinOnly?: boolean;
  ilRisk?: "yes" | "no";
  minApy?: number;
  maxApy?: number;
  minTvl?: number;
  search?: string;
  // A pool "involves" a token when that token's address appears in its
  // underlyingTokens array - confirmed live that this field is populated
  // on every pool (12,991/12,991), so it's a reliable way to find real
  // pools relevant to a given token, not a best-effort field. Matched
  // case-insensitively: sample data has mixed-case EVM addresses
  // alongside lowercase ones for the same token.
  underlyingTokenAddress?: string;
  sortBy?: "apy" | "tvl";
  sortDir?: "asc" | "desc";
}

function buildConditions(filters: YieldFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.chainSlug) conditions.push(eq(chains.slug, filters.chainSlug));
  if (filters.protocolSlug) conditions.push(eq(protocols.slug, filters.protocolSlug));
  if (filters.category) conditions.push(eq(protocols.category, filters.category));
  if (filters.stablecoinOnly) conditions.push(eq(yieldPools.stablecoin, true));
  if (filters.ilRisk) conditions.push(eq(yieldPools.ilRisk, filters.ilRisk));
  if (filters.minApy != null) conditions.push(gte(yieldPools.apy, filters.minApy.toString()));
  if (filters.maxApy != null) conditions.push(lte(yieldPools.apy, filters.maxApy.toString()));
  if (filters.minTvl != null) conditions.push(gte(yieldPools.tvlUsd, filters.minTvl.toString()));
  if (filters.search) {
    const term = `%${escapeLikePattern(filters.search)}%`;
    const clause = or(ilike(yieldPools.symbol, term), ilike(protocols.name, term));
    if (clause) conditions.push(clause);
  }
  if (filters.underlyingTokenAddress) {
    conditions.push(
      sql`exists (
        select 1 from jsonb_array_elements_text(${yieldPools.underlyingTokens}) as elem
        where lower(elem) = lower(${filters.underlyingTokenAddress})
      )`,
    );
  }
  return conditions;
}

function baseQuery() {
  return db
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
      protocolCategory: protocols.category,
    })
    .from(yieldPools)
    .innerJoin(chains, eq(chains.id, yieldPools.chainId))
    .leftJoin(protocols, eq(protocols.id, yieldPools.protocolId))
    .$dynamic();
}

interface YieldPoolRow {
  id: string;
  symbol: string;
  apy: string | null;
  apyBase: string | null;
  apyReward: string | null;
  tvlUsd: string | null;
  stablecoin: boolean;
  ilRisk: string | null;
  externalPoolId: string;
  chainName: string;
  chainSlug: string;
  chainLogoUrl: string | null;
  protocolName: string | null;
  protocolSlug: string | null;
  protocolLogoUrl: string | null;
  protocolCategory: string | null;
}

function normalizeRows(rows: YieldPoolRow[]) {
  return rows.map((r) => ({
    ...r,
    apy: r.apy != null ? Number(r.apy) : null,
    apyBase: r.apyBase != null ? Number(r.apyBase) : null,
    apyReward: r.apyReward != null ? Number(r.apyReward) : null,
    tvlUsd: r.tvlUsd != null ? Number(r.tvlUsd) : null,
  }));
}

function sortColumn(filters: YieldFilters) {
  const column = filters.sortBy === "tvl" ? yieldPools.tvlUsd : yieldPools.apy;
  return filters.sortDir === "asc" ? asc(column) : desc(column);
}

export interface PaginatedYieldPools {
  items: ReturnType<typeof normalizeRows>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function getYieldPoolsList(
  filters: YieldFilters & { page?: number; pageSize?: number } = {},
): Promise<PaginatedYieldPools> {
  const { page, pageSize } = normalizePagination(filters);
  const conditions = buildConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Count first, then clamp the requested page to what actually exists,
  // before computing the offset - see the identical comment in
  // getProtocolsList (queries/protocols.ts) for why this needs to be
  // sequential rather than run in parallel with the items query.
  const countRows = await db
    .select({ value: count() })
    .from(yieldPools)
    .innerJoin(chains, eq(chains.id, yieldPools.chainId))
    .leftJoin(protocols, eq(protocols.id, yieldPools.protocolId))
    .where(where);
  const total = countRows[0]?.value ?? 0;
  const clampedPage = Math.min(page, computeTotalPages(total, pageSize));

  const rows = await baseQuery()
    .where(where)
    // Secondary sort on id for stable pagination - apy/tvlUsd tie
    // frequently (many pools sit at exactly 0), and Postgres doesn't
    // guarantee tie order across separate LIMIT/OFFSET calls without one.
    .orderBy(sortColumn(filters), yieldPools.id)
    .limit(pageSize)
    .offset((clampedPage - 1) * pageSize);

  return {
    items: normalizeRows(rows),
    page: clampedPage,
    pageSize,
    total,
    totalPages: computeTotalPages(total, pageSize),
  };
}

// Used by the v1 public API and CSV export - filtered but not paged, capped
// at a generous ceiling instead. Kept separate from getYieldPoolsList rather
// than reusing it with pageSize=MAX, since callers here don't want a
// page/totalPages envelope, just the rows.
const UNPAGED_MAX_ROWS = 2000;

export async function getYieldPools(filters: YieldFilters = {}) {
  const conditions = buildConditions(filters);
  const rows = await baseQuery()
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sortColumn(filters))
    .limit(UNPAGED_MAX_ROWS);

  return normalizeRows(rows);
}

export async function getYieldPoolCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(yieldPools);
  return row?.value ?? 0;
}

export async function getYieldCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: protocols.category })
    .from(yieldPools)
    .innerJoin(protocols, eq(protocols.id, yieldPools.protocolId))
    .where(isNotNull(protocols.category))
    .orderBy(protocols.category);
  return rows.map((r) => r.category).filter((c): c is string => Boolean(c));
}
