import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokens } from "@/lib/database/schema";
import { latestPriceLateral } from "./tokens";

// This app has no dedicated stablecoin data source (no supply/peg-tracking
// sync exists) - but stablecoins are already tracked as ordinary tokens
// through the ordinary token-discovery pipeline, since they're top-market-
// cap assets on every chain. Confirmed live against the real database
// before building this: USDT/USDC/DAI/USDS/USDe/TUSD/FDUSD/PYUSD are all
// already present with real price/market-cap history.
//
// Identified by CoinGecko id, not by ticker symbol: a symbol like "USDT" is
// just a label a token's own contract metadata reports and isn't guaranteed
// unique - an unrelated or fake token that the discovery pipeline ever
// picked up under the same ticker on some chain would otherwise get merged
// into the real asset's row. coingeckoId is the canonical identity the
// discovery pipeline itself resolves from CoinGecko (the same field
// getTokenChainPresence already uses elsewhere in this codebase for "is
// this the same real asset on another chain"), so it isn't spoofable by a
// same-ticker impersonator the way a bare symbol match is. Verified live:
// every one of these 8 symbols currently maps to exactly one coingeckoId in
// the tracked data, so this is a defensive identity fix, not a behavior
// change against today's real data.
export const KNOWN_STABLECOIN_IDS = [
  "tether",
  "usd-coin",
  "dai",
  "usds",
  "ethena-usde",
  "true-usd",
  "first-digital-usd",
  "paypal-usd",
] as const;

export interface StablecoinChainPresence {
  chainSlug: string;
  chainName: string;
  chainLogoUrl: string | null;
  address: string;
}

export interface StablecoinListItem {
  symbol: string;
  name: string | null;
  logoUrl: string | null;
  // A representative token id/address - prefers a chain deployment that
  // actually has price data (see getStablecoins below) so an unpriced
  // deployment never blanks out an asset that has real data on another
  // chain. Used only to source a real history chart via the existing
  // per-token history route, never displayed as if it were a single-chain
  // balance.
  representativeTokenId: string;
  representativeAddress: string;
  representativeChainSlug: string;
  priceUsd: number | null;
  priceChange24h: number | null;
  // Confirmed live: CoinGecko's per-contract market data reports the same
  // *global* market cap for every chain a token is deployed on, not a
  // per-chain breakdown (checked USDC's 7 tracked chains - identical
  // figure on all of them). Using it as "market cap" (the accurate,
  // intended meaning of the field) rather than implying it's an amount
  // held on any one specific chain, or that it equals circulating supply -
  // those only agree when the asset is exactly at its $1 peg.
  marketCap: number | null;
  chains: StablecoinChainPresence[];
}

// Per-asset: every chain's own row for this stablecoin, plus each row's
// latest price snapshot where one exists. A left join (not inner) so a
// chain deployment discovered but not yet priced still shows up in
// `chains` instead of silently vanishing from the asset's chain-presence
// list - the price-refresh sync and the token-discovery sync run on
// different schedules, so a brand-new deployment can briefly have no
// token_prices row at all.
export async function getStablecoins(): Promise<StablecoinListItem[]> {
  const latest = latestPriceLateral();
  const rows = await db
    .select({
      tokenId: tokens.id,
      coingeckoId: tokens.coingeckoId,
      symbol: tokens.symbol,
      name: tokens.name,
      logoUrl: tokens.logoUrl,
      address: tokens.address,
      chainSlug: chains.slug,
      chainName: chains.name,
      chainLogoUrl: chains.logoUrl,
      priceUsd: latest.priceUsd,
      priceChange24h: latest.priceChange24h,
      marketCap: latest.marketCap,
    })
    .from(tokens)
    .innerJoin(chains, eq(chains.id, tokens.chainId))
    .leftJoinLateral(latest, sql`true`)
    .where(inArray(tokens.coingeckoId, [...KNOWN_STABLECOIN_IDS]))
    .orderBy(tokens.symbol, chains.slug);

  const byId = new Map<string, StablecoinListItem>();
  const hasPricedRepresentative = new Set<string>();
  for (const r of rows) {
    // Guaranteed non-null: the WHERE clause above only matches rows whose
    // coingeckoId is one of KNOWN_STABLECOIN_IDS.
    const key = r.coingeckoId as string;
    const chainEntry: StablecoinChainPresence = {
      chainSlug: r.chainSlug,
      chainName: r.chainName,
      chainLogoUrl: r.chainLogoUrl,
      address: r.address,
    };
    const priceUsd = r.priceUsd != null ? Number(r.priceUsd) : null;
    const priceChange24h = r.priceChange24h != null ? Number(r.priceChange24h) : null;
    const marketCap = r.marketCap != null ? Number(r.marketCap) : null;

    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, {
        symbol: r.symbol,
        name: r.name,
        logoUrl: r.logoUrl,
        representativeTokenId: r.tokenId,
        representativeAddress: r.address,
        representativeChainSlug: r.chainSlug,
        priceUsd,
        priceChange24h,
        marketCap,
        chains: [chainEntry],
      });
      if (priceUsd != null) hasPricedRepresentative.add(key);
    } else {
      existing.chains.push(chainEntry);
      if (!hasPricedRepresentative.has(key) && priceUsd != null) {
        existing.representativeTokenId = r.tokenId;
        existing.representativeAddress = r.address;
        existing.representativeChainSlug = r.chainSlug;
        existing.priceUsd = priceUsd;
        existing.priceChange24h = priceChange24h;
        existing.marketCap = marketCap;
        hasPricedRepresentative.add(key);
      }
    }
  }

  return [...byId.values()].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
}
