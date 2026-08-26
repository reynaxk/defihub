import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { manuallyAdvanceCursor } from "../../lib/indexing/manual-recovery";
import { logger } from "../../lib/observability/logger";
import { VOLUME_SOURCE_POOLS } from "../../lib/onchain/volume/config";

// Section 35's operator-only manual recovery for a stuck volume-indexing
// cursor - see lib/indexing/manual-recovery.ts's own module comment for
// exactly when this is (and is NOT) appropriate: only after confirming
// scanFromCursor's own adaptive range-shrinking (lib/indexing/events.ts)
// genuinely cannot make progress even at the minimum chunk size, and after
// accepting that the skipped block range's events are permanently
// unindexed. Never wired to any cron schedule or API route - run by hand:
//
//   npm run recover:volume-cursor -- <poolKey> <toBlock> "<reason>"
//
// <poolKey> must match a real lib/onchain/volume/config.ts VOLUME_SOURCE_POOLS
// entry - this deliberately does NOT accept an arbitrary chain/contract
// address, so it can't be used to point at data this app doesn't already
// know about.
async function main() {
  const [poolKey, toBlockArg, reason] = process.argv.slice(2);
  if (!poolKey || !toBlockArg || !reason) {
    logger.error("volume-recover: missing arguments", { component: "onchain-volume-recovery" });
    console.error('Usage: npm run recover:volume-cursor -- <poolKey> <toBlock> "<reason>"');
    process.exitCode = 1;
    return;
  }

  const pool = VOLUME_SOURCE_POOLS.find((p) => p.key === poolKey);
  if (!pool) {
    logger.error("volume-recover: unknown pool key", { component: "onchain-volume-recovery", poolKey });
    console.error(`Unknown pool key "${poolKey}" - see lib/onchain/volume/config.ts's VOLUME_SOURCE_POOLS for valid keys`);
    process.exitCode = 1;
    return;
  }

  let toBlock: bigint;
  try {
    toBlock = BigInt(toBlockArg);
  } catch {
    logger.error("volume-recover: toBlock is not a valid integer", { component: "onchain-volume-recovery", toBlockArg });
    process.exitCode = 1;
    return;
  }

  const component = `volume:${pool.sourceKind}:${pool.key}`;
  const result = await manuallyAdvanceCursor(pool.chainSlug, component, toBlock, reason);

  logger.warn("volume indexing: cursor manually advanced by operator", {
    component: "onchain-volume-recovery",
    pool: pool.key,
    previousCursor: result.previousCursor?.toString() ?? null,
    newCursor: result.newCursor.toString(),
    reason,
  });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    logger.error("manual cursor recovery failed", { component: "onchain-volume-recovery", error: err });
    await closeDb();
    process.exitCode = 1;
  });
