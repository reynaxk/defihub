import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { priceAllReferenceAssets } from "../../lib/onchain/pricing/price-reference-assets";
import { logger } from "../../lib/observability/logger";
import { withSyncRun } from "../../lib/observability/sync-run";

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
    let ok = 0;
    for (const r of results) {
      if (r.ok) {
        ok++;
        logger.info("priced", { component: "onchain-pricing", key: r.key });
      } else {
        logger.warn("skipped", { component: "onchain-pricing", key: r.key, reason: r.error });
      }
    }

    const failed = results.length - ok;
    return {
      result: undefined,
      stats: {
        recordsProcessed: results.length,
        errorCount: failed,
        metadata: { priced: ok, skipped: failed },
      },
      outcome: failed > 0 ? ("partial" as const) : ("success" as const),
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
