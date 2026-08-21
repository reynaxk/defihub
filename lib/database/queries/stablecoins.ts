import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, tokens } from "@/lib/database/schema";
import { latestPriceLateral } from "./tokens";

// This app has no dedicated stablecoin data source (no supply/peg-tracking
// sync exists) - but stablecoins are already tracked as ordinary tokens
// through the ordinary token-discovery pipeline, since they're top-market-
// cap assets on every chain. Confirmed live against the real database
// before building this: USDT/USDC/DAI/USDS/USDe/TUSD/FDUSD/PYUSD are all
// already present with real price/market-cap history. Curated by symbol
// rather than a stored "is stablecoin" flag, because `tokens` has no such
// column - this list is deliberately small and named, not a heuristic
// (e.g. "price near $1"), so it can't misclassify a depegging or volatile
// asset as a stablecoin.
export const KNOWN_STABLECOIN_SYMBOLS = ["USDT", "USDC", "DAI", "USDS", "USDE", "TUSD", "FDUSD", "PYUSD"] as const;

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
  // A representative token id/address (arbitrarily the first chain
  // encountered) - used only to source a real history chart via the
  // existing per-token history route, never displayed as if it were a
  // single-chain balance.
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
  // held on any one specific chain.
  marketCap: number | null;
  chains: StablecoinChainPresence[];
}

// Per-symbol: every chain's own row for this stablecoin, plus each row's
// latest price snapshot (already deduplicated to "latest per token" via
// the existing per-token history/price pattern used throughout tokens.ts -
// here done with a plain latest-timestamp join since this only runs for a
// small, fixed set of ~8 symbols, not the full token table).
export async function getStablecoins(): Promise<StablecoinListItem[]> {
  const latest = latestPriceLateral();
  const rows = await db
    .select({
      tokenId: tokens.id,
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
    .innerJoinLateral(latest, sql`true`)
    .where(inArray(tokens.symbol, [...KNOWN_STABLECOIN_SYMBOLS]))
    .orderBy(tokens.symbol, chains.slug);

  const bySymbol = new Map<string, StablecoinListItem>();
  for (const r of rows) {
    const existing = bySymbol.get(r.symbol);
    const chainEntry: StablecoinChainPresence = {
      chainSlug: r.chainSlug,
      chainName: r.chainName,
      chainLogoUrl: r.chainLogoUrl,
      address: r.address,
    };
    if (!existing) {
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        name: r.name,
        logoUrl: r.logoUrl,
        representativeTokenId: r.tokenId,
        representativeAddress: r.address,
        representativeChainSlug: r.chainSlug,
        priceUsd: r.priceUsd != null ? Number(r.priceUsd) : null,
        priceChange24h: r.priceChange24h != null ? Number(r.priceChange24h) : null,
        marketCap: r.marketCap != null ? Number(r.marketCap) : null,
        chains: [chainEntry],
      });
    } else {
      existing.chains.push(chainEntry);
    }
  }

  return [...bySymbol.values()].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
}
