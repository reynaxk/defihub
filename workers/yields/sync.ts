import "dotenv/config";
import { inArray, sql } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chains, protocols, yieldPools } from "../../lib/database/schema";
import { defiDataProvider } from "../../lib/providers";
import { SUPPORTED_CHAINS } from "../../lib/config/chains";
import { chunk } from "../../lib/utils/chunk";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

const SUPPORTED_DEFILLAMA_NAMES = new Set(SUPPORTED_CHAINS.map((c) => c.defillamaSlug));
const BATCH_SIZE = 500;
// Ignore dust pools - keeps the Yields page useful and the table small.
const MIN_TVL_USD = 10_000;

export async function syncYields(): Promise<void> {
  await withSyncRun("yields", async () => {
    const pools = await defiDataProvider.getYieldPools();
    if (pools.length === 0) {
      // An empty upstream response is a provider problem (outage, schema
      // change, rate limit), not a quiet no-op - recording it as success
      // would hide an ingestion outage behind a healthy sync-health status.
      // Genuinely zero pools meeting the chain/TVL filter (the normal case)
      // is handled separately below, after this check.
      throw new Error("yield provider returned zero pools");
    }
    const relevant = pools.filter(
      (p) => SUPPORTED_DEFILLAMA_NAMES.has(p.chain) && (p.tvlUsd ?? 0) >= MIN_TVL_USD,
    );
    logger.info("fetched pools", { component: "yields", recordsProcessed: pools.length, relevant: relevant.length });
    if (relevant.length === 0) return { result: undefined, stats: { recordsProcessed: 0 } };

    const chainRows = await db.select().from(chains);
    const chainIdByDefillamaName = new Map(
      chainRows.filter((c) => c.defillamaSlug).map((c) => [c.defillamaSlug as string, c.id]),
    );

    const protocolSlugs = [...new Set(relevant.map((p) => p.protocolExternalSlug).filter(Boolean))] as string[];
    const protocolIdBySlug = new Map<string, string>();
    for (const batch of chunk(protocolSlugs, BATCH_SIZE)) {
      const rows = await db
        .select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug })
        .from(protocols)
        .where(inArray(protocols.defillamaSlug, batch));
      for (const row of rows) {
        if (row.defillamaSlug) protocolIdBySlug.set(row.defillamaSlug, row.id);
      }
    }

    const rows = relevant
      .map((p) => {
        const chainId = chainIdByDefillamaName.get(p.chain);
        if (!chainId) return null;
        return {
          externalPoolId: p.externalPoolId,
          protocolId: p.protocolExternalSlug ? (protocolIdBySlug.get(p.protocolExternalSlug) ?? null) : null,
          chainId,
          symbol: p.symbol,
          underlyingTokens: p.underlyingTokens,
          apy: p.apy != null ? p.apy.toString() : null,
          apyBase: p.apyBase != null ? p.apyBase.toString() : null,
          apyReward: p.apyReward != null ? p.apyReward.toString() : null,
          tvlUsd: p.tvlUsd != null ? p.tvlUsd.toString() : null,
          stablecoin: p.stablecoin,
          ilRisk: p.ilRisk,
          updatedAt: new Date(),
        };
      })
      .filter((r) => r !== null);

    for (const batch of chunk(rows, BATCH_SIZE)) {
      await db
        .insert(yieldPools)
        .values(batch)
        .onConflictDoUpdate({
          target: yieldPools.externalPoolId,
          set: {
            protocolId: sql`excluded.protocol_id`,
            symbol: sql`excluded.symbol`,
            underlyingTokens: sql`excluded.underlying_tokens`,
            apy: sql`excluded.apy`,
            apyBase: sql`excluded.apy_base`,
            apyReward: sql`excluded.apy_reward`,
            tvlUsd: sql`excluded.tvl_usd`,
            stablecoin: sql`excluded.stablecoin`,
            ilRisk: sql`excluded.il_risk`,
            updatedAt: sql`now()`,
          },
        });
    }

    logger.info("sync complete", { component: "yields", recordsProcessed: rows.length });

    return { result: undefined, stats: { recordsProcessed: rows.length } };
  });
}

if (require.main === module) {
  syncYields()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("sync failed", { component: "yields", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
