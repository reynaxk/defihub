import { sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import {
  historicalObservations,
  onchainVerifications,
  type HistoricalObservationCalculationInput,
} from "@/lib/database/schema";
import { VALID_BLOCK_HASH } from "./verification-key";

// The atomic write shared by recordPoolVerification (verify-pool.ts) and
// recordVaultVerification (verify-vault.ts) - both functions' transaction
// bodies were byte-for-byte identical except for which config/table each
// pulled its own identifiers from, so this is that shared logic, extracted
// once both entity types needed it. Deliberately does NOT log anything
// itself: pool and vault callers keep their own distinct logging context
// (poolKey vs vaultKey fields, their own log message text) by inspecting
// the returned VerificationWriteOutcome and logging at their own call site
// - merging that logging in here would have erased which entity type (and
// which specific key) a skip actually applied to.
export type VerifiedEntityType = "pool" | "vault";

export interface VerificationWriteRecord {
  entityType: VerifiedEntityType;
  // The literal onchain_verifications.key value to upsert, already fully
  // resolved by the caller. onchain_verifications.key is one shared
  // varchar(64) namespace across every category that writes to it (pools,
  // vaults, and the legacy VERIFIED_PROTOCOL_TVLS entries) - a bare,
  // human-chosen config key could otherwise collide across categories and
  // silently overwrite an unrelated entity's "latest value" row. Pool
  // callers pass their bare poolKey unchanged (preserving exactly what
  // Phase 4/5.1 already wrote - no disruption to already-live rows); vault
  // callers namespace theirs with a "vault:" prefix - see
  // recordVaultVerification in verify-vault.ts, and the matching prefix in
  // getVerifiedVaults' join (lib/database/queries/vaults.ts).
  verificationKey: string;
  protocolId: string | null;
  chainId: string;
  label: string;
  // Written into onchain_verifications.poolAddress - a generically-named
  // existing column (predates vaults) that already just means "the
  // contract address this verification read from."
  contractAddress: string;
  tvlUsdForVerification: string;
  blockNumber: string;
  runTimestamp: Date;
  // null means "chain not yet synced into the entity's own canonical
  // table (pools/vaults)" - skip the history write, but still commit the
  // onchain_verifications upsert above.
  entityId: string | null;
  tvlUsdForObservation: string;
  blockHash: string | null;
  priceSource: string;
  priceRetrievedAt: Date;
  calculationInputs: HistoricalObservationCalculationInput[] | null;
  calculationVersion: string;
}

export type VerificationWriteOutcome =
  | "written"
  | "skipped-no-entity" // entityId was null - no historical_observations write was ever attempted
  | "skipped-invalid-hash"; // entityId was set but blockHash was missing/malformed - a real skip worth logging

// See lib/onchain/verify-pool.ts's original recordPoolVerification for the
// full reasoning this preserves unchanged: atomic verification+history
// write (one transaction, or neither commits), VALID_BLOCK_HASH gating the
// history write, the explicit partial-index onConflictDoNothing target
// (never a bare onConflictDoNothing(), which would silently absorb a
// conflict against any unique index on the table), and idempotency via
// that same target.
export async function recordVerification(record: VerificationWriteRecord): Promise<VerificationWriteOutcome> {
  let outcome: VerificationWriteOutcome = "skipped-no-entity";

  await db.transaction(async (tx) => {
    await tx
      .insert(onchainVerifications)
      .values({
        key: record.verificationKey,
        protocolId: record.protocolId,
        chainId: record.chainId,
        label: record.label,
        poolAddress: record.contractAddress,
        tvlUsd: record.tvlUsdForVerification,
        blockNumber: record.blockNumber,
      })
      .onConflictDoUpdate({
        target: onchainVerifications.key,
        set: {
          protocolId: record.protocolId,
          chainId: record.chainId,
          tvlUsd: record.tvlUsdForVerification,
          blockNumber: record.blockNumber,
          verifiedAt: record.runTimestamp,
        },
      });

    if (!record.entityId) return; // outcome stays "skipped-no-entity"

    const hasValidBlockHash = record.blockHash != null && VALID_BLOCK_HASH.test(record.blockHash);
    if (!hasValidBlockHash) {
      outcome = "skipped-invalid-hash";
      return;
    }

    await tx
      .insert(historicalObservations)
      .values({
        chainId: record.chainId,
        entityType: record.entityType,
        entityId: record.entityId,
        metric: "tvl_usd",
        value: record.tvlUsdForObservation,
        timestamp: record.runTimestamp,
        blockNumber: record.blockNumber,
        blockHash: record.blockHash,
        priceSource: record.priceSource,
        priceRetrievedAt: record.priceRetrievedAt,
        calculationInputs: record.calculationInputs,
        source: "onchain-verification",
        calculationVersion: record.calculationVersion,
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

    outcome = "written";
  });

  return outcome;
}
