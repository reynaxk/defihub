import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokenPrices, tokens } from "@/lib/database/schema";

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

export async function getTokensList(
  opts: { chainSlug?: string; sort?: TokenSort } = {},
): Promise<TokenListItem[]> {
  const conditions = opts.chainSlug ? [eq(chains.slug, opts.chainSlug)] : [];

  const orderColumn =
    opts.sort === "price"
      ? latestPricePerToken.priceUsd
      : opts.sort === "volume24h"
        ? latestPricePerToken.volume24h
        : opts.sort === "priceChange24h"
          ? latestPricePerToken.priceChange24h
          : latestPricePerToken.marketCap;

  const rows = await db
    .select({
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
    })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .innerJoin(latestPricePerToken, eq(latestPricePerToken.tokenId, tokens.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${orderColumn} desc nulls last`);

  return rows.map((r) => ({
    ...r,
    priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
    marketCap: r.marketCap != null ? Number(r.marketCap) : null,
    volume24h: r.volume24h != null ? Number(r.volume24h) : null,
    priceChange24h: r.priceChange24h != null ? Number(r.priceChange24h) : null,
  }));
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

  const [row] = await db
    .select({ token: tokens, chainName: chains.name, chainSlug: chains.slug })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .where(and(...conditions))
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
