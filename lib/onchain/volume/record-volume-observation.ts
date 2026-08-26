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

export type VolumeObservationWriteOutcome = "written" | "skipped-invalid-hash";

export async function recordVolumeObservation(record: VolumeObservationRecord): Promise<VolumeObservationWriteOutcome> {
  const hasValidBlockHash = record.blockHash != null && VALID_BLOCK_HASH.test(record.blockHash);
  if (!hasValidBlockHash) return "skipped-invalid-hash";

  await db
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
    });

  return "written";
}
