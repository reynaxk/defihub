import { db } from "@/lib/database/client";
import { chains } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { roundExactDecimal } from "@/lib/onchain/verify-pool";
import { REFERENCE_ASSETS } from "./config";
import { priceReferenceAssetsOnChain } from "./engine";
import { recordTokenPriceObservation } from "./record-price-observation";
import { syncReferenceAssetTokens } from "./tokens";

// historical_observations.value is numeric(32,8) - see verify-pool.ts's own
// OBSERVATION_VALUE_DECIMALS comment for why this many decimals matter (a
// real sub-cent-per-unit price shouldn't floor to zero before it's ever
// written). roundExactDecimal itself is reused unmodified from verify-pool.ts
// - the exact same BigInt-only, round-half-up rescaling this whole app
// already relies on for the identical purpose.
const OBSERVATION_VALUE_DECIMALS = 8;

// Bumped only if the reference-asset pricing methodology itself changes
// (e.g. a second adapter kind, or a materially different aggregation rule) -
// the same "distinguish how a figure was computed, never silently mix
// incompatible historical figures" purpose as TVL_CALCULATION_VERSION in
// verify-pool.ts/verify-vault.ts.
const PRICE_CALCULATION_VERSION = "reference-asset-v2-graph-v1";

// The top-level entry point a worker calls: prices every configured
// reference asset, across every chain REFERENCE_ASSETS touches, and
// persists each successful result. Structurally the same shape as
// verifyAllPools/verifyAllVaults (verify-pool.ts/verify-vault.ts) - sync the
// canonical rows this run's writes will reference, group by chain, price
// each chain's assets in one batched call, then record each one
// individually with its own try/catch so one asset's failure (a bad read, a
// DB error) never stops the rest of this run.
export async function priceAllReferenceAssets(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  if (REFERENCE_ASSETS.length === 0) return [];

  const tokenIdByAssetKey = await syncReferenceAssetTokens();

  const chainRows = await db.select({ id: chains.id, slug: chains.slug }).from(chains);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const chainSlugs = [...new Set(REFERENCE_ASSETS.map((a) => a.chainSlug))];
  const perChainOutcomes = await Promise.all(chainSlugs.map((slug) => priceReferenceAssetsOnChain(slug)));
  const outcomeByKey = new Map(perChainOutcomes.flat().map((o) => [o.key, o]));

  const runTimestamp = new Date();
  const results: { key: string; ok: boolean; error?: string }[] = [];

  for (const asset of REFERENCE_ASSETS) {
    const outcome = outcomeByKey.get(asset.key);
    if (!outcome || !outcome.ok) {
      results.push({ key: asset.key, ok: false, error: outcome?.error ?? "no result" });
      continue;
    }

    const chainId = chainIdBySlug.get(asset.chainSlug);
    if (!chainId) {
      results.push({ key: asset.key, ok: false, error: `chain "${asset.chainSlug}" not found in DB` });
      continue;
    }

    const priceUsdForObservation = roundExactDecimal(outcome.priceUsd!, OBSERVATION_VALUE_DECIMALS);
    const blockNumber = String(outcome.blockNumber!);

    try {
      const writeOutcome = await recordTokenPriceObservation({
        tokenId: tokenIdByAssetKey.get(asset.key) ?? null,
        chainId,
        priceUsd: priceUsdForObservation,
        blockNumber,
        blockHash: outcome.blockHash ?? null,
        timestamp: runTimestamp,
        priceSource: "onchain-pricing-engine",
        priceRetrievedAt: runTimestamp,
        calculationInputs: outcome.sources ?? [],
        calculationVersion: PRICE_CALCULATION_VERSION,
        confidence: outcome.confidence!,
        priceLabel: outcome.label!,
      });

      if (writeOutcome === "skipped-no-token") {
        logger.warn("skipping native token price observation - token not yet synced into `tokens`", {
          component: "onchain-pricing",
          assetKey: asset.key,
          chainSlug: asset.chainSlug,
        });
      } else if (writeOutcome === "skipped-invalid-hash") {
        logger.warn("skipping native token price observation - block hash unavailable or invalid", {
          component: "onchain-pricing",
          assetKey: asset.key,
          blockNumber,
          blockHash: outcome.blockHash,
        });
      }

      results.push({ key: asset.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: asset.key, ok: false, error: message });
    }
  }

  return results;
}
