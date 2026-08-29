import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { manuallyAdvanceCursor } from "../../lib/indexing/manual-recovery";
import { FACTORY_DEPLOYMENTS } from "../../lib/onchain/discovery/config";
import { logger } from "../../lib/observability/logger";

// The discovery twin of workers/onchain/volume-recover.ts - same
// operator-only, never-cron-wired, non-empty-reason-required contract (see
// lib/indexing/manual-recovery.ts's own module comment for exactly when
// this is appropriate). Run by hand:
//
//   npm run recover:discovery-cursor -- <deploymentKey> <toBlock> "<reason>"
//
// <deploymentKey> must match a real lib/onchain/discovery/config.ts
// FACTORY_DEPLOYMENTS entry - this deliberately does NOT accept an
// arbitrary chain/factory address, so it can't be used to point discovery
// at a deployment this app doesn't already know about.
async function main() {
  const [deploymentKey, toBlockArg, reason] = process.argv.slice(2);
  if (!deploymentKey || !toBlockArg || !reason) {
    logger.error("discover-pools-recover: missing arguments", { component: "onchain-discovery-recovery" });
    console.error('Usage: npm run recover:discovery-cursor -- <deploymentKey> <toBlock> "<reason>"');
    process.exitCode = 1;
    return;
  }

  const deployment = FACTORY_DEPLOYMENTS.find((d) => d.key === deploymentKey);
  if (!deployment) {
    logger.error("discover-pools-recover: unknown deployment key", { component: "onchain-discovery-recovery", deploymentKey });
    console.error(`Unknown deployment key "${deploymentKey}" - see lib/onchain/discovery/config.ts's FACTORY_DEPLOYMENTS for valid keys`);
    process.exitCode = 1;
    return;
  }

  let toBlock: bigint;
  try {
    toBlock = BigInt(toBlockArg);
  } catch {
    logger.error("discover-pools-recover: toBlock is not a valid integer", { component: "onchain-discovery-recovery", toBlockArg });
    process.exitCode = 1;
    return;
  }

  const component = `discovery:${deployment.key}`;
  const result = await manuallyAdvanceCursor(deployment.chainSlug, component, toBlock, reason);

  logger.warn("pool discovery: cursor manually advanced by operator", {
    component: "onchain-discovery-recovery",
    deployment: deployment.key,
    previousCursor: result.previousCursor?.toString() ?? null,
    newCursor: result.newCursor.toString(),
    reason,
  });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    logger.error("manual discovery cursor recovery failed", { component: "onchain-discovery-recovery", error: err });
    await closeDb();
    process.exitCode = 1;
  });
