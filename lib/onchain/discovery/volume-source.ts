import { logger } from "@/lib/observability/logger";
import { FACTORY_DEPLOYMENTS } from "./config";
import { getActiveDiscoveredPools } from "./queries";
import { discoveredPoolConfigKey } from "./register";
import { VOLUME_SOURCE_POOLS, type VolumeSourcePool } from "../volume/config";

// The bridge Section 11 asks for: every "active" discovered pool mapped
// into the EXACT SAME VolumeSourcePool shape config-curated pools already
// use, so indexAllPoolVolume/recheckVolumeReorgs (engine.ts/reorg.ts) need
// zero awareness that a pool came from discovery rather than a hand-typed
// config entry - it enters the identical reliable indexing machinery
// (chunking, checkpointing, retry/failover, reorg-safe identity,
// confidence-gated pricing, honest coverage) with no bypass of any of it.
//
// `key` calls the SAME discoveredPoolConfigKey function register.ts itself
// uses to write `pools.configKey` (not a re-implementation of its format)
// - engine.ts's own getPoolIdByConfigKey lookup depends on this exact
// string resolving to the same `pools` row register.ts created, so the two
// computations could never be allowed to silently drift apart by being
// maintained as two separate copies of the same format string.
//
// `coingeckoId` is deliberately the empty string, never fabricated or
// guessed - a discovered token has no CoinGecko contract-lookup ever
// performed for it (this phase does not add one - Section 23's "no
// external providers for discovery"), and this field is purely
// informational metadata attached to a persisted observation
// (VolumeCalculationInput), never consulted by the pricing/aggregation
// logic itself (which resolves native prices by chainSlug+address against
// REFERENCE_ASSETS, not by coingeckoId). A discovered pool's own
// volume/fees will genuinely be UNPRICED for any swap whose input side is
// the non-reference-asset token - an honest, expected limitation of
// native pricing coverage for a newly-discovered token, not a bug (see
// docs/native-data.md's Phase 5.9 section).
function toVolumeSourcePool(deployment: (typeof FACTORY_DEPLOYMENTS)[number], row: Awaited<ReturnType<typeof getActiveDiscoveredPools>>[number]): VolumeSourcePool {
  // Phase 5.11: V2's fee is a trusted deployment-level constant
  // (deployment.feeBps); V3's is a fact about the discovered POOL itself,
  // read from row.feeTier (raw on-chain units, e.g. 500) and converted via
  // the same /100 rule VolumeSourcePool.v3FeeTierRaw's own comment already
  // establishes for the hand-curated V3 config entry. An "active" row for
  // a V3 deployment is guaranteed to carry a real feeTier - validate-v3.ts's
  // own resolveV3ValidationOutcome rejects (never accepts) a candidate
  // whose fee() read failed or whose feeTier is unset before
  // markDiscoveredPoolActive is ever called - so a null value reaching
  // here is a genuine data-integrity bug, thrown loudly rather than
  // silently defaulted to some plausible-looking fee (Section 22's "never
  // fabricate").
  const feeBps = deployment.dexKind === "uniswap-v3" ? v3FeeTierToBps(deployment, row) : deployment.feeBps;

  return {
    key: discoveredPoolConfigKey(deployment.chainSlug, row.poolAddress),
    chainSlug: deployment.chainSlug,
    poolAddress: row.poolAddress,
    sourceKind: deployment.dexKind,
    token0: { address: row.token0Address, symbol: row.token0Symbol ?? "UNKNOWN", decimals: row.token0Decimals, coingeckoId: "" },
    token1: { address: row.token1Address, symbol: row.token1Symbol ?? "UNKNOWN", decimals: row.token1Decimals, coingeckoId: "" },
    factoryAddress: deployment.factoryAddress,
    feeBps,
    ...(deployment.dexKind === "uniswap-v3" && row.feeTier != null ? { v3FeeTierRaw: row.feeTier } : {}),
    feeVerification:
      deployment.dexKind === "uniswap-v3"
        ? `deployment "${deployment.key}" - feeBps (${feeBps}) derived from this pool's own live fee() read (raw ${row.feeTier}), cross-checked against the PoolCreated event at discovery-validation time - genuine factory lineage confirmed (pool.factory() == ${deployment.factoryAddress})`
        : `deployment "${deployment.key}" feeBps (${feeBps}) - genuine factory lineage confirmed at discovery-validation time (pool.factory() == ${deployment.factoryAddress})`,
    // The pool's own REAL creation block - a genuinely correct value, not
    // a guessed recent floor the way hand-curated config entries need
    // (this app was never running when those pools were created; it WAS
    // running, and read this exact block live, when this one was
    // discovered). engine.ts's effectiveStartBlock still applies the same
    // "never further back than the provider can actually serve" correction
    // if real time has since moved the safe window past it.
    startBlock: BigInt(row.creationBlockNumber),
  };
}

function v3FeeTierToBps(deployment: (typeof FACTORY_DEPLOYMENTS)[number], row: Awaited<ReturnType<typeof getActiveDiscoveredPools>>[number]): number {
  if (row.feeTier == null) {
    throw new Error(
      `toVolumeSourcePool: active discovered pool "${row.poolAddress}" (deployment "${deployment.key}") has no feeTier recorded - validation should never have accepted a V3 candidate without one`,
    );
  }
  // V3's native unit is hundredths-of-a-bip, denominator 1,000,000, vs this
  // app's shared fee unit's denominator of 10,000 - exact for every
  // standard V3 tier (100->1, 500->5, 3000->30, 10000->100), the identical
  // conversion lib/onchain/volume/config.ts's own hand-curated
  // "uniswap-v3-eth-usdc-weth-005" entry already documents.
  return row.feeTier / 100;
}

// Every config-curated pool PLUS every active discovered pool, in the
// exact shape indexAllPoolVolume/recheckVolumeReorgs already consume.
// Config pools always come first (unchanged ordering/behavior for
// existing pools); discovered pools are appended, grouped by their own
// deployment. A DB read failure here propagates to the caller rather than
// silently falling back to config-only - better a visible failure than
// quietly indexing fewer pools than actually exist without anyone
// noticing (matching Section 22's "coverage must remain honest": a
// discovered pool that exists but was silently excluded from a run is a
// different, worse failure mode than the run itself failing loudly).
export async function getAllVolumeSourcePools(): Promise<VolumeSourcePool[]> {
  const active = await getActiveDiscoveredPools();
  const deploymentByKey = new Map(FACTORY_DEPLOYMENTS.map((d) => [d.key, d]));

  const discovered: VolumeSourcePool[] = [];
  for (const row of active) {
    const deployment = deploymentByKey.get(row.deploymentKey);
    if (!deployment) {
      // A deployment removed from FACTORY_DEPLOYMENTS after pools were
      // already discovered/activated under it - this pool's own
      // pools/swap_events/historical_observations rows all still exist
      // and are still "active" in discovered_pools, but it would
      // otherwise silently stop being indexed AND reorg-rechecked with no
      // record anywhere of why (Section 21/24's "no silent success" - a
      // config edit that quietly and permanently stops covering existing
      // real data is exactly the kind of thing that must be visible, not
      // absorbed). FACTORY_DEPLOYMENTS entries are not expected to be
      // removed once added (this module's own header comment: "facts
      // about the deployment itself... that don't change"), so this is a
      // loud signal something unusual happened, not routine log noise.
      logger.warn("pool discovery: active discovered pool's deployment is no longer configured - excluded from this run, indexing/reorg-checking has silently stopped for it", {
        component: "onchain-discovery",
        deploymentKey: row.deploymentKey,
        poolAddress: row.poolAddress,
      });
      continue;
    }
    discovered.push(toVolumeSourcePool(deployment, row));
  }

  return [...VOLUME_SOURCE_POOLS, ...discovered];
}
