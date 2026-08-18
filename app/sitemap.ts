import type { MetadataRoute } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocols, tokens } from "@/lib/database/schema";

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [allProtocols, allChains, allTokens] = await Promise.all([
    db.select({ slug: protocols.slug, updatedAt: protocols.updatedAt }).from(protocols),
    db.select({ slug: chains.slug }).from(chains),
    // The same token address can exist on multiple chains (confirmed live -
    // e.g. the native-ETH placeholder address appears on several) - a bare
    // /token/{address} URL with no chain qualifier resolves ambiguously
    // (getTokenByAddress falls back to an unordered `.limit(1)` when no
    // chain is given, so which chain's data renders there isn't stable).
    // Emitting the chain-qualified URL here matches every other internal
    // link to a token detail page (search results, tables), giving each
    // sitemap entry a single stable, canonical target instead.
    db
      .select({ address: tokens.address, chainSlug: chains.slug })
      .from(tokens)
      .innerJoin(chains, eq(chains.id, tokens.chainId)),
  ]);

  return [
    { url: siteUrl, changeFrequency: "hourly", priority: 1 },
    { url: `${siteUrl}/protocols`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${siteUrl}/chains`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${siteUrl}/yields`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${siteUrl}/tokens`, changeFrequency: "hourly", priority: 0.9 },
    ...allProtocols.map((p) => ({
      url: `${siteUrl}/protocol/${p.slug}`,
      lastModified: p.updatedAt,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
    ...allChains.map((c) => ({
      url: `${siteUrl}/chain/${c.slug}`,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
    ...allTokens.map((t) => ({
      url: `${siteUrl}/token/${t.address}?chain=${t.chainSlug}`,
      changeFrequency: "hourly" as const,
      priority: 0.6,
    })),
  ];
}
