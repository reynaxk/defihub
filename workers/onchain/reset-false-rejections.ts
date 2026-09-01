import "dotenv/config";
import { and, eq, isNull, like } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { discoveredPools } from "../../lib/database/schema";
import { logger } from "../../lib/observability/logger";

// One-time, operator-run correction (never cron-wired, same convention as
// discover-pools-recover.ts / backfill-discovered-pool-configkeys.ts) -
// Phase 5.11's own "factory()/fee() read fails within an otherwise-
// successful multicall" false-rejection bug (see
// lib/onchain/discovery/validate.ts's own module comment on
// hasIncompleteRequiredFields for the full live-confirmed root cause) was
// found and fixed with a bounded retry, but the FIX is prospective - it
// does not retroactively correct candidates that were already marked
// "rejected" by the pre-fix code. Live-verified this phase: all 15 rows
// this specific rejection reason produced in the dev database were
// ground-truth-confirmed as REAL, valid pools (two of them directly, by
// calling factory() outside this app's own code and cross-checking a
// second, independent RPC provider) and share timestamps clustered
// entirely BEFORE the retry fix was deployed - not a coincidence, the
// exact batch this phase's own live diagnosis used as evidence.
//
// Scoped narrowly and defensively: only rows whose rejectionReason is
// EXACTLY the "factory() read failed" text this specific bug produces
// (never a broader "reset every rejected row" sweep, which would also
// reset genuinely, correctly rejected malformed contracts) and whose
// validatedAt falls on or before FALSE_REJECTION_CUTOFF (this phase's own
// retry-fix deployment moment, hardcoded here rather than left as a
// runtime argument - a wide-open "reset anything before whatever time I
// pass in" flag is exactly the kind of unbounded operator footgun Section
// 46 warns against). Idempotent: a row already reset to "discovered" no
// longer matches status = "rejected", so a second run finds nothing left
// to touch. Never deletes anything - resets status/rejectionReason/
// validatedAt back to the same "not yet validated" shape a fresh discovery
// would produce, so the NEXT validatePendingPools run gives these
// candidates a genuine, fair re-validation with the fix actually in
// place - it does not fabricate acceptance.
const FALSE_REJECTION_REASON_PREFIX = "factory() read failed - pool contract may not exist or does not implement the expected interface";
const FALSE_REJECTION_CUTOFF = new Date("2026-09-02T00:00:00.000Z");

async function main() {
  const affected = await db
    .select({ id: discoveredPools.id, poolAddress: discoveredPools.poolAddress, deploymentKey: discoveredPools.deploymentKey, validatedAt: discoveredPools.validatedAt })
    .from(discoveredPools)
    .where(and(eq(discoveredPools.status, "rejected"), like(discoveredPools.rejectionReason, `${FALSE_REJECTION_REASON_PREFIX}%`)));

  const toReset = affected.filter((row) => row.validatedAt != null && row.validatedAt <= FALSE_REJECTION_CUTOFF);

  logger.info("reset-false-rejections: starting", {
    component: "onchain-discovery-correction",
    matchingReason: affected.length,
    beforeCutoff: toReset.length,
    cutoff: FALSE_REJECTION_CUTOFF.toISOString(),
  });

  if (toReset.length === 0) {
    logger.info("reset-false-rejections: nothing to reset", { component: "onchain-discovery-correction" });
    return;
  }

  for (const row of toReset) {
    await db
      .update(discoveredPools)
      .set({ status: "discovered", rejectionReason: null, validatedAt: null, updatedAt: new Date() })
      .where(and(eq(discoveredPools.id, row.id), isNull(discoveredPools.poolId))); // defensive: never touch a row that somehow already has a linked pools row
    logger.info("reset-false-rejections: reset one candidate for re-validation", {
      component: "onchain-discovery-correction",
      deployment: row.deploymentKey,
      pool: row.poolAddress,
    });
  }

  logger.info("reset-false-rejections: complete", { component: "onchain-discovery-correction", reset: toReset.length });
}

if (require.main === module) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("reset-false-rejections failed", { component: "onchain-discovery-correction", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
