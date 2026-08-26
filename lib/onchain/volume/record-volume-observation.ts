import { sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { historicalObservations, type VolumeCalculationInput } from "@/lib/database/schema";
import { VALID_BLOCK_HASH } from "@/lib/onchain/verification-key";

// The write path for one aggregate volume/fees/revenue observation
// (entityType "pool", metric "volume_usd" | "fees_usd" | "revenue_usd") -
// structurally the same shape as recordTokenPriceObservation
// (lib/onchain/pricing/record-price-observation.ts): same
// invalid-hash/no-entity refusal, same onConflictDoNothing against the
// identical shared partial unique index every historical_observations
// writer in this app already relies on
// (historical_observations_block_hash_identity_unique). entityType "pool"
// already participates in that index via tvl_usd rows (verify-pool.ts) -
// volume_usd/fees_usd/revenue_usd need no new index, just a new `metric`
// value on the same rows.
export interface VolumeObservationRecord {
  poolId: string;
  chainId: string;
  metric: "volume_usd" | "fees_usd" | "revenue_usd";
  value: string;
  blockNumber: string;
  blockHash: string | null;
  timestamp: Date;
  calculationInputs: VolumeCalculationInput;
  calculationVersion: string;
  // Reuses historicalObservations' existing `confidence` column, repurposed
  // for this metric family: HIGH means every swap this run priced cleanly,
  // MEDIUM means some did and some didn't, LOW means none did (see
  // classifyVolumeConfidence, aggregate.ts) - never the token-price
  // corroboration meaning Phase 5.3 uses this same column for elsewhere,
  // but the same underlying idea ("how much should this number be
  // trusted") applied to a different metric family.
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

// "written" and "duplicate-ignored" are both non-error outcomes (a
// duplicate is expected, idempotent-correct behavior on a retried run -
// see this file's own conflict target comment), but they are NOT the same
// fact: a caller that needs to know whether a row genuinely landed just
// now (e.g. to decide whether to also update something conditioned on a
// fresh write) must be able to tell them apart, the same way
// recordSwapEvents' own returned count already distinguishes "0 inserted"
// from "N inserted" rather than collapsing both into a bare success/fail.
export type VolumeObservationWriteOutcome = "written" | "duplicate-ignored" | "skipped-invalid-hash";

export async function recordVolumeObservation(record: VolumeObservationRecord): Promise<VolumeObservationWriteOutcome> {
  const hasValidBlockHash = record.blockHash != null && VALID_BLOCK_HASH.test(record.blockHash);
  if (!hasValidBlockHash) return "skipped-invalid-hash";

  const rows = await db
    .insert(historicalObservations)
    .values({
      chainId: record.chainId,
      entityType: "pool",
      entityId: record.poolId,
      metric: record.metric,
      value: record.value,
      timestamp: record.timestamp,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      calculationInputs: record.calculationInputs,
      source: "onchain-volume-engine",
      calculationVersion: record.calculationVersion,
      confidence: record.confidence,
      priceLabel: "ONCHAIN_NATIVE",
    })
    .onConflictDoNothing({
      target: [
        historicalObservations.entityType,
        historicalObservations.entityId,
        historicalObservations.metric,
        historicalObservations.blockNumber,
        historicalObservations.blockHash,
      ],
      where: sql`${historicalObservations.blockNumber} is not null and ${historicalObservations.blockHash} is not null`,
    })
    .returning({ id: historicalObservations.id });

  // onConflictDoNothing suppresses the insert without erroring - `rows` is
  // only non-empty when a row was genuinely written this call. Previously
  // this function returned "written" unconditionally whenever the hash was
  // valid, even when the conflict silently suppressed the insert - a real
  // duplicate write was indistinguishable from a genuine one.
  return rows.length > 0 ? "written" : "duplicate-ignored";
}
