import { eq, ilike, or } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocols, tokens } from "@/lib/database/schema";

const RESULTS_PER_KIND = 5;

export interface SearchResult {
  kind: "protocol" | "chain" | "token";
  name: string;
  subtitle: string | null;
  href: string;
  logoUrl: string | null;
}

// A lightweight as-you-type lookup, not a ranked list - ilike scans on
// protocols.name (~3000 rows) / tokens.symbol+name (~400 rows) / chains.name
// (5 rows) are cheap sequential scans at this scale, same tradeoff the
// protocols list's existing search already makes. Revisit with a trigram
// index only if this table growth actually makes it slow.
export async function search(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q}%`;

  const [protocolRows, chainRows, tokenRows] = await Promise.all([
    db
      .select({ name: protocols.name, slug: protocols.slug, category: protocols.category, logoUrl: protocols.logoUrl })
      .from(protocols)
      .where(ilike(protocols.name, pattern))
      .orderBy(protocols.name)
      .limit(RESULTS_PER_KIND),
    db
      .select({ name: chains.name, slug: chains.slug, nativeToken: chains.nativeToken, logoUrl: chains.logoUrl })
      .from(chains)
      .where(ilike(chains.name, pattern))
      .orderBy(chains.name)
      .limit(RESULTS_PER_KIND),
    db
      .select({ symbol: tokens.symbol, name: tokens.name, address: tokens.address, logoUrl: tokens.logoUrl, chainSlug: chains.slug })
      .from(tokens)
      .innerJoin(chains, eq(chains.id, tokens.chainId))
      .where(or(ilike(tokens.symbol, pattern), ilike(tokens.name, pattern)))
      .orderBy(tokens.symbol)
      .limit(RESULTS_PER_KIND),
  ]);

  return [
    ...protocolRows.map((p) => ({
      kind: "protocol" as const,
      name: p.name,
      subtitle: p.category,
      href: `/protocol/${p.slug}`,
      logoUrl: p.logoUrl,
    })),
    ...chainRows.map((c) => ({
      kind: "chain" as const,
      name: c.name,
      subtitle: c.nativeToken,
      href: `/chain/${c.slug}`,
      logoUrl: c.logoUrl,
    })),
    ...tokenRows.map((t) => ({
      kind: "token" as const,
      name: t.symbol,
      subtitle: t.name,
      href: `/token/${t.address}?chain=${t.chainSlug}`,
      logoUrl: t.logoUrl,
    })),
  ];
}
