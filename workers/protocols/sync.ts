import "dotenv/config";
import { inArray, sql } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chains, protocolChains, protocolMetrics, protocols } from "../../lib/database/schema";
import { defiDataProvider } from "../../lib/providers";
import { SUPPORTED_CHAINS } from "../../lib/config/chains";
import { chunk } from "../../lib/utils/chunk";

const SUPPORTED_DEFILLAMA_NAMES = new Set(SUPPORTED_CHAINS.map((c) => c.defillamaSlug));
const BATCH_SIZE = 500;

export async function syncProtocols() {
  const [allProtocols, financials, volumeBySlug] = await Promise.all([
    defiDataProvider.getProtocols(),
    defiDataProvider.getProtocolFees(),
    defiDataProvider.getProtocolVolume(),
  ]);

  const relevant = allProtocols.filter((p) =>
    p.chains.some((c) => SUPPORTED_DEFILLAMA_NAMES.has(c)),
  );
  console.log(
    `[protocols] fetched ${allProtocols.length}, ${relevant.length} deployed on a supported chain`,
  );
  if (relevant.length === 0) return;

  const financialsBySlug = new Map(financials.map((f) => [f.externalId, f]));
  const chainRows = await db.select().from(chains);
  const chainIdByDefillamaName = new Map(
    chainRows.filter((c) => c.defillamaSlug).map((c) => [c.defillamaSlug as string, c.id]),
  );

  // 1. Bulk upsert protocols
  for (const batch of chunk(relevant, BATCH_SIZE)) {
    await db
      .insert(protocols)
      .values(
        batch.map((p) => ({
          name: p.name,
          slug: p.slug,
          description: p.description,
          website: p.website,
          logoUrl: p.logoUrl,
          category: p.category,
          defillamaSlug: p.externalId,
        })),
      )
      .onConflictDoUpdate({
        target: protocols.defillamaSlug,
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          website: sql`excluded.website`,
          logoUrl: sql`excluded.logo_url`,
          category: sql`excluded.category`,
          updatedAt: sql`now()`,
        },
      });
  }

  // 2. Resolve slug -> id for everything we just touched
  const protocolIdBySlug = new Map<string, string>();
  for (const batch of chunk(
    relevant.map((p) => p.externalId),
    BATCH_SIZE,
  )) {
    const rows = await db
      .select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug })
      .from(protocols)
      .where(inArray(protocols.defillamaSlug, batch));
    for (const row of rows) {
      if (row.defillamaSlug) protocolIdBySlug.set(row.defillamaSlug, row.id);
    }
  }

  // 3. Bulk insert protocol_chains + protocol_metrics
  const now = new Date();
  const chainLinkRows: { protocolId: string; chainId: string }[] = [];
  const metricRows: {
    protocolId: string;
    chainId: string | null;
    timestamp: Date;
    tvl: string | null;
    volume24h: string | null;
    fees24h: string | null;
    revenue24h: string | null;
  }[] = [];

  for (const p of relevant) {
    const protocolId = protocolIdBySlug.get(p.externalId);
    if (!protocolId) continue;

    const matchedChainNames = p.chains.filter((c) => SUPPORTED_DEFILLAMA_NAMES.has(c));
    const fin = financialsBySlug.get(p.externalId);
    const volume = volumeBySlug.get(p.externalId) ?? null;

    metricRows.push({
      protocolId,
      chainId: null,
      timestamp: now,
      tvl: p.tvl != null ? p.tvl.toString() : null,
      volume24h: volume != null ? volume.toString() : null,
      fees24h: fin?.fees24h != null ? fin.fees24h.toString() : null,
      revenue24h: fin?.revenue24h != null ? fin.revenue24h.toString() : null,
    });

    for (const chainName of matchedChainNames) {
      const chainId = chainIdByDefillamaName.get(chainName);
      if (!chainId) continue;
      chainLinkRows.push({ protocolId, chainId });

      const chainTvl = p.tvlByChain[chainName];
      if (chainTvl != null) {
        metricRows.push({
          protocolId,
          chainId,
          timestamp: now,
          tvl: chainTvl.toString(),
          volume24h: null,
          fees24h: null,
          revenue24h: null,
        });
      }
    }
  }

  for (const batch of chunk(chainLinkRows, BATCH_SIZE)) {
    if (batch.length === 0) continue;
    await db.insert(protocolChains).values(batch).onConflictDoNothing();
  }

  for (const batch of chunk(metricRows, BATCH_SIZE)) {
    if (batch.length === 0) continue;
    await db.insert(protocolMetrics).values(batch).onConflictDoNothing();
  }

  console.log(
    `[protocols] synced ${protocolIdBySlug.size} protocols, ${chainLinkRows.length} chain links, ${metricRows.length} metric rows`,
  );
}

if (require.main === module) {
  syncProtocols()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[protocols] sync failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
