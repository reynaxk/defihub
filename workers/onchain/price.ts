import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { priceAllReferenceAssets, type ReferenceAssetPriceResult } from "../../lib/onchain/pricing/price-reference-assets";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

export interface PriceRunSummary {
  priced: number;
  skipped: number;
  failed: number;
  outcome: "success" | "partial";
}

// Pure - turns one run's per-asset results into the run's overall stats and
// success/partial classification, directly unit-testable with plain
// constructed inputs (see price.test.ts). Deliberately extracted rather
// than inlined into priceOnchain below: the accounting rule itself
// (skipped-no-token and skipped-invalid-hash both count as skipped, never
// as priced; the run is "success" only when EVERY requested asset actually
// persisted) is exactly the kind of decision this codebase always pulls out
// into a pure function so it can be tested without a real DB/RPC round-trip
// - the same pattern as resolveVaultOutcome, resolveReferenceAssetOutcome,
// priceSourceForTokens, isNativePriceEligibleForTvl.
export function summarizePriceResults(results: ReferenceAssetPriceResult[]): PriceRunSummary {
  let priced = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of results) {
    if (r.outcome === "written") priced++;
    else if (r.outcome === "skipped-no-token" || r.outcome === "skipped-invalid-hash") skipped++;
    else failed++;
  }

  // "success" requires every single requested asset to have actually
  // persisted a real observation this run - a skip is not a failure in the
  // exception-thrown sense, but it's still not a successful price
  // observation, and must never be silently absorbed into a clean-looking
  // "success" outcome. Zero requested assets (REFERENCE_ASSETS empty, or
  // every asset otherwise excluded before this point) also reports
  // "success" here - priceAllReferenceAssets already short-circuits to an
  // empty results array in that case, so `results.length === 0` correctly
  // falls through this same `priced === results.length` check.
  const outcome: PriceRunSummary["outcome"] = priced === results.length ? "success" : "partial";
  return { priced, skipped, failed, outcome };
}

// Phase 5.3's independent on-chain price engine, run as its own worker -
// deliberately separate from verify.ts (pool/vault/protocol-TVL
// verification) rather than folded into it, even though both are triggered
// on a similar cadence: reference-asset pricing is a genuine dependency of
// a *future* TVL source-selection policy, not a replacement for today's
// CoinGecko-based one, and keeping it its own sync_runs worker name
// ("onchain-price") means a failure here is independently visible in
// /api/cron/health rather than blurred into "onchain"'s existing pool/
// vault/protocol-TVL success rate. Same withSyncRun/logger pattern as
// verify.ts throughout.
export async function priceOnchain(): Promise<void> {
  await withSyncRun("onchain-price", async () => {
    const results = await priceAllReferenceAssets();
    for (const r of results) {
      if (r.outcome === "written") {
        logger.info("priced", { component: "onchain-pricing", key: r.key });
      } else {
        logger.warn(r.outcome, { component: "onchain-pricing", key: r.key, reason: r.error });
      }
    }

    const summary = summarizePriceResults(results);
    return {
      result: undefined,
      stats: {
        recordsProcessed: results.length,
        errorCount: results.length - summary.priced,
        metadata: { priced: summary.priced, skipped: summary.skipped, failed: summary.failed },
      },
      outcome: summary.outcome,
    };
  });
}

if (require.main === module) {
  priceOnchain()
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("pricing failed", { component: "onchain-pricing", error: err });
      await closeDb();
      process.exitCode = 1;
    });
}
