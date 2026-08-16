import type { MetadataRoute } from "next";
import { db } from "@/lib/database/client";
import { chains, protocols } from "@/lib/database/schema";

const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [allProtocols, allChains] = await Promise.all([
    db.select({ slug: protocols.slug, updatedAt: protocols.updatedAt }).from(protocols),
    db.select({ slug: chains.slug }).from(chains),
  ]);

  return [
    { url: siteUrl, changeFrequency: "hourly", priority: 1 },
    { url: `${siteUrl}/protocols`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${siteUrl}/chains`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${siteUrl}/yields`, changeFrequency: "hourly", priority: 0.9 },
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
  ];
}
