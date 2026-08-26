import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { recheckVolumeReorgs } from "../../lib/onchain/volume/reorg";
import { logger } from "../../lib/observability/logger";

// The invocable-script wrapper for lib/onchain/volume/reorg.ts's
// recheckVolumeReorgs - same dotenv/closeDb/require.main pattern as every
// other workers/onchain/*.ts entry point. recheckVolumeReorgs itself
// already wraps its work in withSyncRun ("onchain-volume-reorg-recheck"),
// so this file stays a thin invocation shell, matching
// recheck-reorgs.ts's own split between logic-that-happens-to-be-runnable
// and the runnable entry point.
if (require.main === module) {
  recheckVolumeReorgs()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("volume reorg recheck failed", { component: "onchain-volume-reorg-recheck", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
