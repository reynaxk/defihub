import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import { chains, discoveredPools } from "../../lib/database/schema";
import { logger } from "../../lib/observability/logger";

// One-time, operator-run correction (never cron-wired, same convention as
// discover-pools-recover.ts / backfill-discovered-pool-configkeys.ts) -
// Phase 5.11's own "factory()/fee() read fails within an otherwise-
// successful multicall" false-rejection bug (see lib/onchain/discovery/
// validate.ts's own module comment on hasIncompleteRequiredFields for the
// full live-confirmed root cause) was found and fixed with a bounded
// retry, but the FIX is prospective - it does not retroactively correct
// candidates that were already marked "rejected" by the pre-fix code.
//
// PR #19 review round (CodeRabbit + manual review): the original version
// of this script selected rows to reset via `rejectionReason LIKE
// "${prefix}%"` plus a cutoff timestamp. That is NOT provably scoped to
// the exact rows this incident affected - it matches ANY row whose
// rejection reason happens to start with that text, before that time,
// including a genuinely, correctly rejected malformed contract that
// produces the identical literal reason
// ("factory() read failed - pool contract may not exist or does not
// implement the expected interface" is the SAME string
// resolveValidationOutcome/resolveV3ValidationOutcome emit for a real,
// permanently broken contract, not only for the transient per-sub-call
// failure this incident was about) - a reason-text pattern can never, by
// itself, distinguish "this specific pool was falsely rejected" from
// "this other pool is genuinely broken and happens to fail the same way."
//
// Fixed by replacing the pattern-match query with an explicit, hardcoded
// ALLOWLIST of exact (chainSlug, poolAddress) identifiers - the "equally
// strict immutable identifier set" this review round asked for. This
// script now NEVER touches any row not named, verbatim, in
// FALSE_REJECTION_ALLOWLIST below, no matter what its rejection reason or
// timestamp is. On top of that, resetFalseRejections independently
// re-verifies each allowlisted row's CURRENT state exactly matches the
// known false-rejection signature (status, exact reason text, no linked
// poolId, validatedAt before the cutoff) before touching it - a second,
// independent gate, so even a mistaken or stale allowlist entry can never
// force a reset of a row that doesn't actually look like this specific
// bug's output.
//
// The historical incident this script was written for (15 rows, all on
// the pancakeswap-v2-bnb-chain deployment, ground-truth-confirmed as real,
// valid pools - two of them directly, by calling factory() outside this
// app's own code and cross-checking a second, independent RPC provider)
// was fully corrected and re-validated during Phase 5.11's own
// development; a live re-run at the time confirmed all 15 were rescued
// (0 rejected afterward). That specific incident is therefore CLOSED - the
// exact 15 addresses were not captured in any durable, queryable record
// (this script's own logger output was the only trace, and by design nothing
// in this schema keeps a history of a row's PRIOR status/rejectionReason
// once overwritten), so FALSE_REJECTION_ALLOWLIST below is intentionally
// empty rather than populated with reconstructed-and-unverifiable
// addresses - this script does not fabricate a plausible-looking list it
// cannot stand behind. A FUTURE incident of this same class should list
// its own exact, ground-truth-confirmed (chainSlug, poolAddress) pairs
// here before running this script again; running it with an empty
// allowlist is always a safe no-op.
export const FALSE_REJECTION_REASON = "factory() read failed - pool contract may not exist or does not implement the expected interface";
const FALSE_REJECTION_CUTOFF = new Date("2026-09-02T00:00:00.000Z");

export interface FalseRejectionAllowlistEntry {
  chainSlug: string;
  poolAddress: string;
}

const FALSE_REJECTION_ALLOWLIST: readonly FalseRejectionAllowlistEntry[] = [];

export interface ResetResult {
  requested: number;
  reset: number;
  skippedAlreadyResolved: number;
  skippedNotFound: number;
  skippedSignatureMismatch: number;
}

// Exported so this exact mechanism (not just the production allowlist
// constant, which is empty) is directly testable with synthetic rows -
// see reset-false-rejections.integration.test.ts.
export async function resetFalseRejections(allowlist: readonly FalseRejectionAllowlistEntry[]): Promise<ResetResult> {
  let reset = 0;
  let skippedAlreadyResolved = 0;
  let skippedNotFound = 0;
  let skippedSignatureMismatch = 0;

  for (const entry of allowlist) {
    const [chain] = await db.select({ id: chains.id }).from(chains).where(eq(chains.slug, entry.chainSlug));
    if (!chain) {
      skippedNotFound++;
      logger.warn("reset-false-rejections: allowlisted chain is not tracked, skipping", {
        component: "onchain-discovery-correction",
        chainSlug: entry.chainSlug,
        poolAddress: entry.poolAddress,
      });
      continue;
    }

    const normalizedAddress = entry.poolAddress.toLowerCase();
    const [row] = await db
      .select({
        id: discoveredPools.id,
        status: discoveredPools.status,
        rejectionReason: discoveredPools.rejectionReason,
        validatedAt: discoveredPools.validatedAt,
        poolId: discoveredPools.poolId,
      })
      .from(discoveredPools)
      .where(and(eq(discoveredPools.chainId, chain.id), eq(discoveredPools.poolAddress, normalizedAddress)));

    if (!row) {
      skippedNotFound++;
      logger.warn("reset-false-rejections: allowlisted (chainSlug, poolAddress) has no matching discovered_pools row, skipping", {
        component: "onchain-discovery-correction",
        chainSlug: entry.chainSlug,
        poolAddress: normalizedAddress,
      });
      continue;
    }

    // Idempotency: a row this script (or a prior run of it) already reset
    // is no longer "rejected" - that's the expected, safe steady state on
    // a second run, not a suspicious mismatch.
    if (row.status !== "rejected") {
      skippedAlreadyResolved++;
      logger.info("reset-false-rejections: allowlisted row is no longer 'rejected' (already resolved, or never was) - skipping, this run is idempotent", {
        component: "onchain-discovery-correction",
        chainSlug: entry.chainSlug,
        poolAddress: normalizedAddress,
        currentStatus: row.status,
      });
      continue;
    }

    // The independent second gate: even a row explicitly named in the
    // allowlist is only ever reset if its CURRENT state exactly matches
    // the known false-rejection signature - exact reason text (never a
    // prefix/LIKE match), no linked pool, and validated before the known
    // cutoff. A genuinely different rejection (or a stale/mistaken
    // allowlist entry) fails this check and is left untouched.
    const matchesKnownSignature = row.rejectionReason === FALSE_REJECTION_REASON && row.poolId == null && row.validatedAt != null && row.validatedAt <= FALSE_REJECTION_CUTOFF;

    if (!matchesKnownSignature) {
      skippedSignatureMismatch++;
      logger.warn("reset-false-rejections: allowlisted row's current state does not exactly match the known false-rejection signature - skipping, never force a reset", {
        component: "onchain-discovery-correction",
        chainSlug: entry.chainSlug,
        poolAddress: normalizedAddress,
        currentReason: row.rejectionReason,
        currentPoolId: row.poolId,
        currentValidatedAt: row.validatedAt,
      });
      continue;
    }

    await db
      .update(discoveredPools)
      .set({ status: "discovered", rejectionReason: null, validatedAt: null, updatedAt: new Date() })
      .where(and(eq(discoveredPools.id, row.id), isNull(discoveredPools.poolId))); // defensive: never touch a row that somehow already has a linked pools row
    reset++;
    logger.info("reset-false-rejections: reset one allowlisted candidate for re-validation", {
      component: "onchain-discovery-correction",
      chainSlug: entry.chainSlug,
      poolAddress: normalizedAddress,
    });
  }

  const result: ResetResult = { requested: allowlist.length, reset, skippedAlreadyResolved, skippedNotFound, skippedSignatureMismatch };
  logger.info("reset-false-rejections: complete", { component: "onchain-discovery-correction", ...result });
  return result;
}

async function main() {
  if (FALSE_REJECTION_ALLOWLIST.length === 0) {
    logger.info("reset-false-rejections: FALSE_REJECTION_ALLOWLIST is empty - nothing to do (the historical incident this script was written for is already fully resolved; see this file's own module comment)", {
      component: "onchain-discovery-correction",
    });
    return;
  }
  await resetFalseRejections(FALSE_REJECTION_ALLOWLIST);
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
