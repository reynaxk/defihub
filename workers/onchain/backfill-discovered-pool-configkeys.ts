import "dotenv/config";
import { eq, like } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chains, pools } from "../../lib/database/schema";
import { discoveredPoolConfigKey } from "../../lib/onchain/discovery/register";
import { logger } from "../../lib/observability/logger";

// One-time, operator-run backfill (never cron-wired, same convention as
// discover-pools-recover.ts) - CodeRabbit PR #17's cross-chain configKey
// fix changed discoveredPoolConfigKey's format from `discovered:<address>`
// to `discovered:<chain discriminator>:<address>` (see register.ts's own
// comment for why). Every discovered pool already registered BEFORE that
// fix shipped still has the OLD, single-segment configKey persisted in
// `pools.config_key` - and getAllVolumeSourcePools/runVolumeReorgRecheck
// now compute the NEW format when looking those same rows up by key
// (getPoolIdByConfigKey), so without this backfill every already-
// discovered pool would silently stop being volume-indexed AND reorg-
// rechecked the moment this fix deploys - the exact "active discovered
// pools must not silently disappear" failure mode a SEPARATE finding this
// same review round asked to prevent, just triggered by this fix instead
// of a deployment-config change. Live-verified against the dev database:
// all 66 existing discovered pools (all on bnb-chain) carry the old
// single-segment format.
//
// Idempotent by construction: only touches rows whose configKey has no
// discriminator segment yet, using the SAME discoveredPoolConfigKey
// function production code calls (never a hand-rolled reimplementation of
// its format) - a second run finds nothing left to update.
function isOldFormatConfigKey(configKey: string): boolean {
  const withoutPrefix = configKey.slice("discovered:".length);
  return !withoutPrefix.includes(":"); // old format has no discriminator segment
}

async function main() {
  const candidates = await db
    .select({ id: pools.id, configKey: pools.configKey, address: pools.address, chainSlug: chains.slug })
    .from(pools)
    .innerJoin(chains, eq(pools.chainId, chains.id))
    .where(like(pools.configKey, "discovered:%"));

  const toMigrate = candidates.filter((row) => isOldFormatConfigKey(row.configKey));
  logger.info("backfill-discovered-pool-configkeys: starting", { component: "onchain-discovery-backfill", totalDiscoveredRows: candidates.length, oldFormatRows: toMigrate.length });

  if (toMigrate.length === 0) {
    logger.info("backfill-discovered-pool-configkeys: nothing to migrate", { component: "onchain-discovery-backfill" });
    return;
  }

  let migrated = 0;
  await db.transaction(async (tx) => {
    for (const row of toMigrate) {
      const newConfigKey = discoveredPoolConfigKey(row.chainSlug, row.address);
      await tx.update(pools).set({ configKey: newConfigKey, updatedAt: new Date() }).where(eq(pools.id, row.id));
      migrated++;
    }
  });

  logger.info("backfill-discovered-pool-configkeys: complete", { component: "onchain-discovery-backfill", migrated });
}

if (require.main === module) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("backfill-discovered-pool-configkeys failed", { component: "onchain-discovery-backfill", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
