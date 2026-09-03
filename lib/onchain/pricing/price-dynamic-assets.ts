import { db } from "@/lib/database/client";
import { chains } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { roundExactDecimal } from "@/lib/onchain/verify-pool";
import { REFERENCE_ASSETS } from "./config";
import { priceDynamicTokensOnChain, type DynamicPricingOutcome } from "./dynamic-engine";
import { recordTokenPriceObservation } from "./record-price-observation";
import { ensureOnChainTokenRow } from "./tokens";

// Phase 5.13's twin of price-reference-assets.ts's own priceAllReferenceAssets
// - same shape (sync canonical rows this run's writes reference, price per
// chain, record each result individually so one asset's failure never stops
// the rest), applied to the dynamically-discovered candidate set instead of
// the 7 hardcoded REFERENCE_ASSETS. Deliberately a SEPARATE function/worker
// from that one, not a merged code path: priceAllReferenceAssets' own 7
// assets are the TRUSTED FOUNDATION this whole engine depends on (including
// this file's own dynamic candidates) - keeping its own run, its own
// success/failure accounting, and its own sync_runs visibility independent
// means a problem with the (much larger, less-reviewed) dynamic tier can
// never be confused with a problem in the foundational 7.
const OBSERVATION_VALUE_DECIMALS = 8;
const PRICE_CALCULATION_VERSION = "dynamic-amm-graph-v1";

export interface DynamicAssetPriceResult {
  key: string;
  chainSlug: string;
  address: string;
  hop: number;
  outcome: "written" | "skipped-no-price" | "skipped-invalid-hash" | "failed";
  confidence?: string;
  error?: string;
}

// Part 17: this function's ENTIRE job is reading already-decoded on-chain
// multicall results (via priceDynamicTokensOnChain) and writing them - it
// never calls priceProvider/CoinGecko/DefiLlama, directly or indirectly.
// The native pricing path stays fully auditable: every dollar value here
// traces back to a real getReserves() read at a real, recorded block.
export async function priceDynamicAssets(): Promise<DynamicAssetPriceResult[]> {
  const chainSlugs = [...new Set(REFERENCE_ASSETS.map((a) => a.chainSlug))];
  const chainRows = await db.select({ id: chains.id, slug: chains.slug }).from(chains);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const results: DynamicAssetPriceResult[] = [];
  const runTimestamp = new Date();

  for (const chainSlug of chainSlugs) {
    const chainId = chainIdBySlug.get(chainSlug);
    if (!chainId) continue; // chain not yet synced - mirrors syncPoolsFromConfig's own skip for this case

    const { outcomes } = await priceDynamicTokensOnChain(chainSlug);
    for (const outcome of outcomes) {
      results.push(await recordOneOutcome(chainId, outcome, runTimestamp));
    }
  }

  return results;
}

async function recordOneOutcome(chainId: string, outcome: DynamicPricingOutcome, runTimestamp: Date): Promise<DynamicAssetPriceResult> {
  const base = { key: outcome.key, chainSlug: outcome.chainSlug, address: outcome.address, hop: outcome.hop };

  if (!outcome.ok || outcome.confidence === "INVALID") {
    logger.info("dynamic native pricing: no usable price this run", { component: "onchain-pricing-dynamic", token: outcome.key, hop: outcome.hop, reason: outcome.error });
    return { ...base, outcome: "skipped-no-price", error: outcome.error };
  }

  // A registered on-chain token row - never a CoinGecko-driven one, see
  // ensureOnChainTokenRow's own comment on why this coexists safely with
  // workers/tokens/sync.ts's separate, independent sync.
  const tokenId = await ensureOnChainTokenRow(chainId, outcome.address, outcome.symbol, outcome.decimals);

  const priceUsdForObservation = roundExactDecimal(outcome.priceUsd!, OBSERVATION_VALUE_DECIMALS);

  try {
    const writeOutcome = await recordTokenPriceObservation({
      tokenId,
      chainId,
      priceUsd: priceUsdForObservation,
      blockNumber: String(outcome.blockNumber!),
      blockHash: outcome.blockHash ?? null,
      timestamp: runTimestamp,
      priceSource: "onchain-pricing-engine-dynamic",
      priceRetrievedAt: runTimestamp,
      calculationInputs: outcome.sources ?? [],
      calculationVersion: PRICE_CALCULATION_VERSION,
      confidence: outcome.confidence!,
      priceLabel: outcome.label!,
    });

    if (writeOutcome === "skipped-invalid-hash") {
      logger.warn("dynamic native pricing: skipping observation - block hash unavailable or invalid", { component: "onchain-pricing-dynamic", token: outcome.key });
      return { ...base, outcome: "skipped-invalid-hash", confidence: outcome.confidence };
    }

    logger.info("dynamic native pricing: priced", { component: "onchain-pricing-dynamic", token: outcome.key, hop: outcome.hop, confidence: outcome.confidence });
    return { ...base, outcome: "written", confidence: outcome.confidence };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, outcome: "failed", error: message };
  }
}
