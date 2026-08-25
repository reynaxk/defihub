import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { verifyAllPools } from "../../lib/onchain/verify-pool";
import { verifyAllProtocolTvls } from "../../lib/onchain/verify-protocol-tvl";
import { verifyAllVaults } from "../../lib/onchain/verify-vault";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export async function verifyOnchain(): Promise<void> {
  await withSyncRun("onchain", async () => {
    const results = [...(await verifyAllPools()), ...(await verifyAllProtocolTvls()), ...(await verifyAllVaults())];
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
