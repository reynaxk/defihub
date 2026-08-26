import { REFERENCE_ASSETS } from "./pricing/config";
import { VERIFIED_POOLS, VERIFIED_VAULTS } from "./config";
import { getIndexingState } from "@/lib/indexing/state";
import { VOLUME_SOURCE_POOLS } from "./volume/config";
import { getLatestVolumeObservation, getPoolIdByConfigKey } from "./volume/queries";

// Section 29's coverage registry - a backend-only, queryable answer to
// "what does DeFiHub actually independently compute, right now, and how
// well." Deliberately NOT a new database table: every fact below is either
// already the hand-curated config itself (which chains/protocols/metrics
// this app has committed to supporting natively - the "supported?" and
// "native?/external?/hybrid?" questions) or already-live data this phase's
// own indexing_state/historical_observations rows carry (the "last indexed
// block?/last observation?/confidence?" questions) - deriving it live
// avoids a second, competing source of truth that could drift from the
// config or the real indexing state it's summarizing. Explicitly the
// foundation only - no API route, no frontend page, per Section 29's own
// "do NOT build the flashy frontend yet."
export type CoverageMetricKind = "tvl_usd" | "price_usd" | "volume_usd" | "fees_usd" | "revenue_usd";
// UNSUPPORTED: architecturally implemented but not currently producing a
// real observation for this pool (e.g. revenue_usd when no revenue_usd row
// has ever been written - see getVolumeCoverage below). Never NATIVE
// without a real observation backing it - the source/provenance contract
// this whole registry exists to uphold (Section 12/38's "never mislabel
// unsupported as supported").
export type CoverageSourceLabel = "NATIVE" | "EXTERNAL" | "HYBRID" | "UNSUPPORTED";

export interface StaticCoverageEntry {
  chainSlug: string;
  protocolKey: string;
  metric: CoverageMetricKind;
  source: CoverageSourceLabel;
  knownLimitations: string[];
}

// TVL and native reference-asset pricing (Phase 5.2/5.3) - membership in
// these hand-curated config arrays already IS the coverage statement
// (every entry is independently verified before being added - see each
// config file's own header comment), so no live query is needed to answer
// "is this native": it's a config-time fact, not a runtime one. Live
// per-entry indexing depth for these is already answerable today via
// getPoolTvlHistory/getVaultTvlHistory/getNativeTokenPrice
// (lib/database/queries/{pools,vaults}.ts, lib/onchain/pricing/queries.ts)
// - not duplicated here.
export function getStaticCoverage(): StaticCoverageEntry[] {
  return [
    ...VERIFIED_POOLS.map((p): StaticCoverageEntry => ({ chainSlug: p.chainSlug, protocolKey: p.key, metric: "tvl_usd", source: "NATIVE", knownLimitations: [] })),
    ...VERIFIED_VAULTS.map((v): StaticCoverageEntry => ({ chainSlug: v.chainSlug, protocolKey: v.key, metric: "tvl_usd", source: "NATIVE", knownLimitations: [] })),
    ...REFERENCE_ASSETS.map((a): StaticCoverageEntry => ({ chainSlug: a.chainSlug, protocolKey: a.key, metric: "price_usd", source: "NATIVE", knownLimitations: [] })),
  ];
}

export interface VolumeCoverageEntry {
  chainSlug: string;
  protocolKey: string;
  metric: CoverageMetricKind;
  source: CoverageSourceLabel;
  lastIndexedBlock: string | null;
  lastObservationAt: Date | null;
  lastObservationValueUsd: string | null;
  knownLimitations: string[];
}

// Phase 5.4's own metrics - genuinely need a live read, unlike the static
// ones above: volume/fees/revenue depend on how far this run's indexer has
// actually progressed (indexing_state.last_processed_block), which is
// runtime state, not a config-time fact.
export async function getVolumeCoverage(pools = VOLUME_SOURCE_POOLS): Promise<VolumeCoverageEntry[]> {
  const entries: VolumeCoverageEntry[] = [];

  for (const pool of pools) {
    const component = `volume:${pool.sourceKind}:${pool.key}`;
    const [state, poolId] = await Promise.all([getIndexingState(pool.chainSlug, component), getPoolIdByConfigKey(pool.key)]);
    const lastIndexedBlock = state?.lastProcessedBlock != null ? state.lastProcessedBlock.toString() : null;

    const [volumeObs, feesObs, revenueObs] = poolId
      ? await Promise.all([
          getLatestVolumeObservation(poolId, "volume_usd"),
          getLatestVolumeObservation(poolId, "fees_usd"),
          getLatestVolumeObservation(poolId, "revenue_usd"),
        ])
      : [null, null, null];

    entries.push({
      chainSlug: pool.chainSlug,
      protocolKey: pool.key,
      metric: "volume_usd",
      source: "NATIVE",
      lastIndexedBlock,
      lastObservationAt: volumeObs?.timestamp ?? null,
      lastObservationValueUsd: volumeObs?.value ?? null,
      knownLimitations: poolId ? [] : ["pool not yet synced into `pools` - run TVL verification first"],
    });
    entries.push({
      chainSlug: pool.chainSlug,
      protocolKey: pool.key,
      metric: "fees_usd",
      source: "NATIVE",
      lastIndexedBlock,
      lastObservationAt: feesObs?.timestamp ?? null,
      lastObservationValueUsd: feesObs?.value ?? null,
      knownLimitations: poolId ? [] : ["pool not yet synced into `pools` - run TVL verification first"],
    });
    entries.push({
      chainSlug: pool.chainSlug,
      protocolKey: pool.key,
      metric: "revenue_usd",
      // Revenue is architecturally native (readV2ProtocolFeeStateAcrossRange/
      // resolveProtocolRevenueForRange, lib/onchain/volume/protocol-fee.ts)
      // but not reliably computable for every deployment - see that
      // module's own header comment. NATIVE only when a real revenue_usd
      // observation actually exists (revenueObs != null) - a pool whose
      // protocol-fee switch is active (so no revenue_usd row has ever been
      // written for it - see engine.ts) must never be reported as
      // supporting native revenue just because the architecture exists;
      // that would violate this registry's whole reason for existing (never
      // claim coverage this app didn't actually produce).
      source: revenueObs != null ? "NATIVE" : "UNSUPPORTED",
      lastIndexedBlock,
      lastObservationAt: revenueObs?.timestamp ?? null,
      lastObservationValueUsd: revenueObs?.value ?? null,
      knownLimitations:
        revenueObs != null
          ? []
          : [
              "protocol revenue requires an active feeTo() mechanism whose realized amount can currently only be verified as exactly zero (feeTo() == 0x0); an active-but-nonzero feeTo() requires Mint/Burn + kLast tracking not implemented this phase - see protocol-fee.ts",
            ],
    });
  }

  return entries;
}
