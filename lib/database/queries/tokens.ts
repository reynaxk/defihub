import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokenPrices, tokens } from "@/lib/database/schema";
import { normalizePagination, totalPages as computeTotalPages } from "@/lib/database/pagination";

// One row per token: the most recent token_prices snapshot. Tokens sync at
// different cadences (the tokens worker writes an initial point, the prices
// worker refreshes every 15 min) so a per-token DISTINCT ON is correct where
// a single shared-timestamp MAX() subquery (as protocols.ts uses) would not
// be, since not every token necessarily has a row at the same timestamp.
const latestPricePerToken = db
  .selectDistinctOn([tokenPrices.tokenId], {
    tokenId: tokenPrices.tokenId,
    priceUsd: tokenPrices.priceUsd,
    marketCap: tokenPrices.marketCap,
    volume24h: tokenPrices.volume24h,
    priceChange24h: tokenPrices.priceChange24h,
  })
  .from(tokenPrices)
  .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp))
  .as("latest_price");

// priceChange7d is only written by the 6-hourly token-discovery sync, not
// the 15-min price-refresh sync (see schema.ts) - most rows have it null, so
// "the latest row" usually wouldn't have a 7d figure. This looks back to the
// most recent row that actually has one, per token.
const latestNon7dNullChange = db
  .selectDistinctOn([tokenPrices.tokenId], {
    tokenId: tokenPrices.tokenId,
    priceChange7d: tokenPrices.priceChange7d,
  })
  .from(tokenPrices)
  .where(isNotNull(tokenPrices.priceChange7d))
  .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp))
  .as("latest_7d_change");

export interface TokenListItem {
  id: string;
  address: string;
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  chainName: string;
  chainSlug: string;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
}

export type TokenSort = "marketCap" | "price" | "volume24h" | "priceChange24h";

function tokenListColumns() {
  return {
    id: tokens.id,
    address: tokens.address,
    symbol: tokens.symbol,
    name: tokens.name,
    logoUrl: tokens.logoUrl,
    chainName: chains.name,
    chainSlug: chains.slug,
    priceUsd: latestPricePerToken.priceUsd,
    marketCap: latestPricePerToken.marketCap,
    volume24h: latestPricePerToken.volume24h,
    priceChange24h: latestPricePerToken.priceChange24h,
  };
}

function tokenSortColumn(sort: TokenSort | undefined) {
  switch (sort) {
    case "price":
      return latestPricePerToken.priceUsd;
    case "volume24h":
      return latestPricePerToken.volume24h;
    case "priceChange24h":
      return latestPricePerToken.priceChange24h;
    default:
      return latestPricePerToken.marketCap;
  }
}

function normalizeTokenRows<T extends { priceUsd: string | null; marketCap: string | null; volume24h: string | null; priceChange24h: string | null }>(
  rows: T[],
) {
  return rows.map((r) => ({
    ...r,
    priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
    marketCap: r.marketCap != null ? Number(r.marketCap) : null,
    volume24h: r.volume24h != null ? Number(r.volume24h) : null,
    priceChange24h: r.priceChange24h != null ? Number(r.priceChange24h) : null,
  }));
}

// Unpaginated - used by CSV export, the v1 API's simple mode, and the chain
// page's "top tokens on this chain" slice, none of which want a page/total
// envelope. ~450 tokens today across 8 chains, comfortably under the cap
// below - same defense-in-depth reasoning as protocols.ts's
// getProtocolsForExport (EXPORT_MAX_ROWS there): the CSV export path has no
// chain filter option to naturally bound it, so this is a ceiling for
// if/when token coverage grows, not a limit expected to bind today.
const TOKENS_MAX_ROWS = 5000;

export async function getTokensList(
  opts: { chainSlug?: string; sort?: TokenSort } = {},
): Promise<TokenListItem[]> {
  const conditions = opts.chainSlug ? [eq(chains.slug, opts.chainSlug)] : [];
  const orderColumn = tokenSortColumn(opts.sort);

  const rows = await db
    .select(tokenListColumns())
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${orderColumn} desc nulls last`)
    .limit(TOKENS_MAX_ROWS);

  return normalizeTokenRows(rows);
}

export interface PaginatedTokens {
  items: TokenListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function getTokensPageList(
  opts: { chainSlug?: string; sort?: TokenSort; page?: number; pageSize?: number } = {},
): Promise<PaginatedTokens> {
  const { page, pageSize } = normalizePagination(opts);
  const conditions = opts.chainSlug ? [eq(chains.slug, opts.chainSlug)] : [];
  const where = conditions.length ? and(...conditions) : undefined;
  const orderColumn = tokenSortColumn(opts.sort);

  // Count first, then clamp the requested page to what actually exists,
  // before computing the offset - see the identical comment in
  // getProtocolsList (queries/protocols.ts) for why this needs to be
  // sequential rather than run in parallel with the items query.
  const countRows = await db
    .select({ value: count() })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(where);
  const total = countRows[0]?.value ?? 0;
  const clampedPage = Math.min(page, computeTotalPages(total, pageSize));

  const rows = await db
    .select(tokenListColumns())
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(where)
    // Secondary sort on id for stable pagination - marketCap/volume24h/
    // priceChange24h tie frequently (many tokens sit at null or 0), and
    // Postgres doesn't guarantee tie order across separate LIMIT/OFFSET
    // calls without one.
    .orderBy(sql`${orderColumn} desc nulls last`, tokens.id)
    .limit(pageSize)
    .offset((clampedPage - 1) * pageSize);

  return {
    items: normalizeTokenRows(rows),
    page: clampedPage,
    pageSize,
    total,
    totalPages: computeTotalPages(total, pageSize),
  };
}

export interface TokenMover {
  id: string;
  address: string;
  chainSlug: string;
  symbol: string;
  logoUrl: string | null;
  priceUsd: number | null;
  priceChange: number;
  sparkline: number[];
}

export type MoverWindow = "24h" | "7d";

// Sorting by raw change (not abs value) naturally surfaces real volatility
// at the extremes without needing to filter out stablecoins separately - a
// stablecoin sitting at +/-0.01% never competes with an actual mover for a
// top-N spot in either direction.
async function queryMovers(limit: number, window: MoverWindow, direction: "desc" | "asc") {
  if (window === "7d") {
    const changeColumn = latestNon7dNullChange.priceChange7d;
    return db
      .select({
        id: tokens.id,
        address: tokens.address,
        chainSlug: chains.slug,
        symbol: tokens.symbol,
        logoUrl: tokens.logoUrl,
        priceUsd: latestPricePerToken.priceUsd,
        priceChange: changeColumn,
      })
      .from(tokens)
      .innerJoin(chains, eq(chains.id, tokens.chainId))
      .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
      .innerJoin(latestNon7dNullChange, eq(latestNon7dNullChange.tokenId, tokens.id))
      .where(isNotNull(changeColumn))
      .orderBy(direction === "desc" ? desc(changeColumn) : asc(changeColumn))
      .limit(limit);
  }

  const changeColumn = latestPricePerToken.priceChange24h;
  return db
    .select({
      id: tokens.id,
      address: tokens.address,
      chainSlug: chains.slug,
      symbol: tokens.symbol,
      logoUrl: tokens.logoUrl,
      priceUsd: latestPricePerToken.priceUsd,
      priceChange: changeColumn,
    })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(isNotNull(changeColumn))
    .orderBy(direction === "desc" ? desc(changeColumn) : asc(changeColumn))
    .limit(limit);
}

export async function getTopMovers(
  limit = 5,
  window: MoverWindow = "24h",
): Promise<{ gainers: TokenMover[]; losers: TokenMover[] }> {
  const [gainerRows, loserRows] = await Promise.all([
    queryMovers(limit, window, "desc"),
    queryMovers(limit, window, "asc"),
  ]);

  const ids = [...gainerRows, ...loserRows].map((r) => r.id);
  const sparklines = await getSparklines(ids);

  const normalize = (rows: typeof gainerRows): TokenMover[] =>
    rows.map((r) => ({
      ...r,
      priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
      priceChange: Number(r.priceChange),
      sparkline: sparklines.get(r.id) ?? [],
    }));

  return { gainers: normalize(gainerRows), losers: normalize(loserRows) };
}

const SPARKLINE_POINTS = 20;

// Batched "last N prices per token", trimmed in JS rather than expressed as
// a SQL window function - simplest safe option at mover-list scale (~10
// tokens, each with at most a few hundred price rows even after months of
// 15-min syncing), and keeps this on the typed query builder like the rest
// of the codebase instead of introducing raw SQL.
async function getSparklines(tokenIds: string[]): Promise<Map<string, number[]>> {
  if (tokenIds.length === 0) return new Map();

  const rows = await db
    .select({ tokenId: tokenPrices.tokenId, priceUsd: tokenPrices.priceUsd, timestamp: tokenPrices.timestamp })
    .from(tokenPrices)
    .where(inArray(tokenPrices.tokenId, tokenIds))
    .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp));

  const byToken = new Map<string, number[]>();
  for (const row of rows) {
    const list = byToken.get(row.tokenId) ?? [];
    if (list.length < SPARKLINE_POINTS) list.push(Number(row.priceUsd));
    byToken.set(row.tokenId, list);
  }
  // Rows came back newest-first (for the take-last-N-cheaply trick above) -
  // reverse each list so sparklines render oldest-to-newest, left to right.
  for (const list of byToken.values()) list.reverse();
  return byToken;
}

export interface TokenPricePoint {
  timestamp: Date;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
}

export interface TokenDetail {
  token: typeof tokens.$inferSelect;
  chain: { name: string; slug: string };
  history: TokenPricePoint[];
  latest: TokenPricePoint | null;
}

// A contract address is only unique per-chain (not globally) - two chains
// can share the same deterministically-deployed address for a bridged
// token - so an optional chainSlug disambiguates when the address alone
// matches more than one row.
export async function getTokenByAddress(address: string, chainSlug?: string): Promise<TokenDetail | null> {
  const conditions = [eq(tokens.address, address)];
  if (chainSlug) conditions.push(eq(chains.slug, chainSlug));

  // A token address can exist on more than one chain (e.g. the native-ETH
  // placeholder address appears on several). Without an explicit order,
  // which one this returns for an address-only lookup isn't guaranteed
  // stable across requests - order by chain slug so a bare /token/{address}
  // visit (no ?chain=) at least always resolves to the same one rather than
  // whatever Postgres happens to return first.
  const [row] = await db
    .select({ token: tokens, chainName: chains.name, chainSlug: chains.slug })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(...conditions))
    .orderBy(chains.slug)
    .limit(1);

  if (!row) return null;

  const history = await db
    .select({
      timestamp: tokenPrices.timestamp,
      priceUsd: tokenPrices.priceUsd,
      marketCap: tokenPrices.marketCap,
      volume24h: tokenPrices.volume24h,
      priceChange24h: tokenPrices.priceChange24h,
    })
    .from(tokenPrices)
    .where(eq(tokenPrices.tokenId, row.token.id))
    .orderBy(tokenPrices.timestamp);

  const normalizedHistory: TokenPricePoint[] = history.map((h) => ({
    timestamp: h.timestamp,
    priceUsd: h.priceUsd != null ? Number(h.priceUsd) : null,
    marketCap: h.marketCap != null ? Number(h.marketCap) : null,
    volume24h: h.volume24h != null ? Number(h.volume24h) : null,
    priceChange24h: h.priceChange24h != null ? Number(h.priceChange24h) : null,
  }));

  return {
    token: row.token,
    chain: { name: row.chainName, slug: row.chainSlug },
    history: normalizedHistory,
    latest: normalizedHistory.length > 0 ? normalizedHistory[normalizedHistory.length - 1] : null,
  };
}

export interface TokenChainPresence {
  chainName: string;
  chainSlug: string;
  address: string;
}

// Same coingeckoId showing up under more than one of our tokens rows means
// the same asset is deployed (natively or bridged) on more than one
// supported chain - real cross-chain presence, not a guess.
export async function getTokenChainPresence(
  coingeckoId: string | null,
  excludeTokenId: string,
): Promise<TokenChainPresence[]> {
  if (!coingeckoId) return [];
  const rows = await db
    .select({ chainName: chains.name, chainSlug: chains.slug, address: tokens.address })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(eq(tokens.coingeckoId, coingeckoId), ne(tokens.id, excludeTokenId)));
  return rows;
}

export interface BalanceCheckToken {
  address: string;
  symbol: string;
  // Null when no confirmed decimals value exists yet (see schema.ts) -
  // callers must not assume a default; the wallet-balances route falls back
  // to a live on-chain read and drops the balance entirely if both fail.
  decimals: number | null;
  logoUrl: string | null;
  priceUsd: number | null;
}

const BALANCE_CHECK_TOKENS_PER_CHAIN = 50;

// The wallet balance viewer only checks tokens this app already tracks
// (no paid token-discovery API), capped per chain to keep each multicall
// request a reasonable size - ordered by market cap so the tokens most
// likely to actually be held show up first if a chain has more than the cap.
export async function getTokensForBalanceCheck(chainSlug: string): Promise<BalanceCheckToken[]> {
  const rows = await db
    .select({
      address: tokens.address,
      symbol: tokens.symbol,
      decimals: tokens.decimals,
      logoUrl: tokens.logoUrl,
      priceUsd: latestPricePerToken.priceUsd,
    })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(eq(chains.slug, chainSlug))
    .orderBy(sql`${latestPricePerToken.marketCap} desc nulls last`)
    .limit(BALANCE_CHECK_TOKENS_PER_CHAIN);

  return rows.map((r) => ({ ...r, priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null }));
}

// The chain's native currency is seeded as its own `tokens` row (see
// seed.ts) so it gets price coverage from the same sync pipeline as every
// other tracked token - matched by symbol against chains.nativeToken rather
// than a hardcoded per-chain sentinel address, and limit(1) ordered by
// market cap breaks a tie if more than one row ever shares that symbol.
export async function getNativeTokenPrice(chainSlug: string): Promise<number | null> {
  const [row] = await db
    .select({ priceUsd: latestPricePerToken.priceUsd })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(and(eq(chains.slug, chainSlug), eq(tokens.symbol, chains.nativeToken)))
    .orderBy(sql`${latestPricePerToken.marketCap} desc nulls last`)
    .limit(1);

  return row?.priceUsd != null ? Number(row.priceUsd) : null;
}
