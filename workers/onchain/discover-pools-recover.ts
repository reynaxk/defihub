import "dotenv/config";
import { confirmationsFor, safeHeadFor } from "../../lib/chains/confirmations";
import { withResilientClient } from "../../lib/chains/rpc-resilient-client";
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
//
// CodeRabbit PR #17 fix: toBlock was previously accepted as any parseable
// integer with no upper bound check - a typo (an extra digit, the wrong
// chain's block number pasted in) would silently jump the cursor to a
// bogus FUTURE block, permanently skipping every real block in between,
// the exact opposite of this tool's own "skip a KNOWN, understood range"
// purpose (manuallyAdvanceCursor's own module comment). toBlock is now
// checked against this deployment's own real, live confirmed chain head
// (the SAME confirmationsFor/safeHeadFor calculation the discovery engine
// itself uses - see lib/onchain/discovery/engine.ts) before
// manuallyAdvanceCursor is ever called - a value above that head is
// rejected outright, and the cursor is never touched.
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

  if (toBlock < BigInt(0)) {
    logger.error("discover-pools-recover: toBlock must not be negative - cursor left unchanged", { component: "onchain-discovery-recovery", toBlockArg });
    console.error(`toBlock (${toBlock}) is negative - refusing to touch the cursor`);
    process.exitCode = 1;
    return;
  }

  const currentBlock = await withResilientClient(deployment.chainSlug, (client) => client.getBlockNumber());
  const confirmedHead = safeHeadFor(deployment.chainSlug, currentBlock);
  if (toBlock > confirmedHead) {
    logger.error("discover-pools-recover: toBlock is beyond the confirmed chain head - cursor left unchanged", {
      component: "onchain-discovery-recovery",
      deployment: deployment.key,
      toBlock: toBlock.toString(),
      confirmedHead: confirmedHead.toString(),
    });
    console.error(
      `toBlock (${toBlock}) exceeds the current confirmed chain head for "${deployment.chainSlug}" (${confirmedHead}, ${confirmationsFor(deployment.chainSlug)} confirmations behind block ${currentBlock}) - refusing to jump the cursor into the future; double-check the value and re-run`,
    );
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
