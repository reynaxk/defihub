import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { verifyDiscoveredPoolsTvl } from "../../lib/onchain/discovery/verify-discovered-pool-tvl";
import { verifyAllPools } from "../../lib/onchain/verify-pool";
import { verifyAllProtocolTvls } from "../../lib/onchain/verify-protocol-tvl";
import { verifyAllVaults } from "../../lib/onchain/verify-vault";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export async function verifyOnchain(): Promise<void> {
  await withSyncRun("onchain", async () => {
    // Phase 5.12: registered discovered pools get the exact same TVL
    // treatment as VERIFIED_POOLS, in the same scheduled run - not a
    // separate cron/worker (Section 22's "reuse existing... primitives"
    // applies to scheduling too). "unavailable" (no reliable price for one
    // or both tokens) is an expected, common outcome here - most
    // discovered pools pair an arbitrary token against a reference asset,
    // and the arbitrary side often isn't priceable at all yet - so this
    // never throws or logs at warn/error level for that case, only via its
    // own per-pool `ok: false` result, folded into the same
    // verified/skipped tally as everything else below.
    const results = [...(await verifyAllPools()), ...(await verifyDiscoveredPoolsTvl()), ...(await verifyAllProtocolTvls()), ...(await verifyAllVaults())];
    let ok = 0;
    for (const r of results) {
      if (r.ok) {
        ok++;
        logger.info("verified", { component: "onchain", key: r.key });
      } else {
        logger.warn("skipped", { component: "onchain", key: r.key, reason: r.error });
      }
    }

    const failed = results.length - ok;
    return {
      result: undefined,
      stats: {
        recordsProcessed: results.length,
        errorCount: failed,
        metadata: { verified: ok, skipped: failed },
      },
      // "partial" once any verified read is skipped - lets the health view
      // distinguish "every configured read checked out" from "some did
      // not," rather than both looking like an undifferentiated success.
      outcome: failed > 0 ? ("partial" as const) : ("success" as const),
    };
  });
}

if (require.main === module) {
  verifyOnchain()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("verify failed", { component: "onchain", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
