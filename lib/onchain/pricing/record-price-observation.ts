import { sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { historicalObservations, type PriceSourceObservation } from "@/lib/database/schema";
import { VALID_BLOCK_HASH } from "@/lib/onchain/verification-key";
import type { PriceConfidence, PriceLabel } from "./types";

// The write path for one native token price observation (entityType
// "token", metric "price_usd") - structurally the same shape as
// recordVerification (lib/onchain/record-verification.ts), but a genuinely
// separate function rather than a shared one, for one deliberate reason:
// recordVerification ALSO unconditionally upserts onchain_verifications (a
// TVL-shaped "latest value" cache - poolAddress/tvlUsd columns), which has
// no honest analog for a price observation. Forcing a price into that
// table's tvl_usd column would be a semantic mismatch (and needlessly
// imprecise - numeric(24,2) rounds to cents, fine for a TVL figure, wrong
// for a token price), and branching recordVerification's own body on entity
// type to skip that upsert conditionally would be exactly the kind of
// entity-specific control flow its own module comment already says it
// deliberately avoids. There is no "latest price" cache table for the same
// reason: a caller that wants the latest price for a token can query
// historicalObservations directly (entityType "token", metric "price_usd",
// ORDER BY timestamp DESC LIMIT 1, reorgInvalidatedAt IS NULL) using the
// exact same historical_observations_entity_idx index every other "latest
// observation" lookup in this app already relies on - see
// lib/onchain/pricing/queries.ts.
export interface TokenPriceObservationRecord {
  // null means "this address isn't in the `tokens` table yet on this chain"
  // (not yet discovered by workers/tokens/sync.ts, or synced) - skip the
  // write entirely rather than inventing a token row here; the next
  // scheduled tokens sync followed by the next pricing run picks it up.
  tokenId: string | null;
  chainId: string;
  priceUsd: string; // exact decimal string, already rounded to this table's numeric(32,8)
  blockNumber: string;
  blockHash: string | null;
  timestamp: Date;
  priceSource: string;
  priceRetrievedAt: Date;
  calculationInputs: PriceSourceObservation[];
  calculationVersion: string;
  confidence: PriceConfidence;
  priceLabel: PriceLabel;
}

export type TokenPriceWriteOutcome = "written" | "skipped-no-token" | "skipped-invalid-hash";

// Refuses to write without a real token row or a real, validly-formatted
// block hash - never fabricates either (same "never trust/never fake
// provenance" discipline as recordVerification). onConflictDoNothing
// targets the exact same partial unique index every other
// historical_observations writer in this app already relies on
// (historical_observations_block_hash_identity_unique) - entityType "token"
// participates in that same shared index without needing a new one, since
// the index itself is not scoped to any particular entityType value.
export async function recordTokenPriceObservation(record: TokenPriceObservationRecord): Promise<TokenPriceWriteOutcome> {
  if (!record.tokenId) return "skipped-no-token";

  const hasValidBlockHash = record.blockHash != null && VALID_BLOCK_HASH.test(record.blockHash);
  if (!hasValidBlockHash) return "skipped-invalid-hash";

  await db
    .insert(historicalObservations)
    .values({
      chainId: record.chainId,
      entityType: "token",
      entityId: record.tokenId,
      metric: "price_usd",
      value: record.priceUsd,
      timestamp: record.timestamp,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      priceSource: record.priceSource,
      priceRetrievedAt: record.priceRetrievedAt,
      calculationInputs: record.calculationInputs,
      source: "onchain-pricing-engine",
      calculationVersion: record.calculationVersion,
      confidence: record.confidence,
      priceLabel: record.priceLabel,
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
