import { and, asc, count, desc, eq, gte, isNull, min, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import {
  chains,
  historicalObservations,
  onchainVerifications,
  protocols,
  vaults,
  type HistoricalObservationCalculationInput,
} from "@/lib/database/schema";
import { VAULT_VERIFICATION_KEY_PREFIX } from "@/lib/onchain/verification-key";

// Phase 5.2's "DeFiHub internal data interface" for ERC-4626 vault TVL -
// the exact structural twin of lib/database/queries/pools.ts, applied to
// `vaults`/entityType "vault" instead of `pools`/"pool". See that file's
// own module comment for the full reasoning (why this operates at the
// granularity of one vault, not "the protocol's TVL, falling back to
// DefiLlama" - a verified vault's totalAssets() is a complete, authoritative
// figure for that one vault, not a claim about the protocol as a whole).
//
// onchain_verifications.key is one shared varchar(64) namespace across
// pools, vaults, and the legacy VERIFIED_PROTOCOL_TVLS entries - a bare
// vault configKey used directly as that key could otherwise collide with an
// unrelated pool/protocol-TVL entry that happens to share the same string,
// silently joining this query to the wrong entity's verification.
// getVerifiedVaults' join below reads the exact same prefix
// lib/onchain/verify-vault.ts's recordVaultVerification writes (via
// vaultVerificationKey) and lib/onchain/config.ts's
// assertUniqueVerificationKeys validates against - imported from
// lib/onchain/verification-key.ts, a dependency-free leaf module with no
// imports of its own, so pulling a single constant from it here doesn't
// create any risk of a cycle back into the onchain write path.


export interface VerifiedVaultListItem {
  id: string;
  configKey: string;
  label: string;
  address: string;
  chainSlug: string;
  chainName: string;
  chainLogoUrl: string | null;
  protocolSlug: string | null;
  protocolName: string | null;
  underlyingSymbol: string;
  // Null when this vault has been synced from config but not yet verified
  // by a live RPC read - never fabricated as 0 or omitted silently.
  latestTvlUsd: number | null;
  latestBlockNumber: number | null;
  latestVerifiedAt: Date | null;
}

export async function getVerifiedVaults(): Promise<VerifiedVaultListItem[]> {
  const rows = await db
    .select({
      id: vaults.id,
      configKey: vaults.configKey,
      label: vaults.label,
      address: vaults.address,
      chainSlug: chains.slug,
      chainName: chains.name,
      chainLogoUrl: chains.logoUrl,
      protocolSlug: protocols.slug,
      protocolName: protocols.name,
      underlyingSymbol: vaults.underlyingSymbol,
      latestTvlUsd: onchainVerifications.tvlUsd,
      latestBlockNumber: onchainVerifications.blockNumber,
      latestVerifiedAt: onchainVerifications.verifiedAt,
    })
    .from(vaults)
    .innerJoin(chains, eq(chains.id, vaults.chainId))
    .leftJoin(protocols, eq(protocols.id, vaults.protocolId))
    .leftJoin(onchainVerifications, eq(onchainVerifications.key, sql`${VAULT_VERIFICATION_KEY_PREFIX} || ${vaults.configKey}`));

  return rows.map((r) => ({
    ...r,
    latestTvlUsd: r.latestTvlUsd != null ? Number(r.latestTvlUsd) : null,
    latestBlockNumber: r.latestBlockNumber != null ? Number(r.latestBlockNumber) : null,
  }));
}

export interface VaultTvlObservation {
  timestamp: Date;
  value: string;
  blockNumber: number | null;
  blockHash: string | null;
  priceSource: string | null;
  priceRetrievedAt: Date | null;
  calculationInputs: HistoricalObservationCalculationInput[] | null;
  source: string;
  calculationVersion: string | null;
}

const DEFAULT_VAULT_TVL_HISTORY_LIMIT = 5000;
const MIN_VAULT_TVL_HISTORY_LIMIT = 1;

export function normalizeVaultTvlHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_VAULT_TVL_HISTORY_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated < MIN_VAULT_TVL_HISTORY_LIMIT) return MIN_VAULT_TVL_HISTORY_LIMIT;
  return Math.min(truncated, DEFAULT_VAULT_TVL_HISTORY_LIMIT);
}

export async function getVaultTvlHistory(
  vaultId: string,
  since: Date | null,
  limit: number = DEFAULT_VAULT_TVL_HISTORY_LIMIT,
): Promise<VaultTvlObservation[]> {
  const normalizedLimit = normalizeVaultTvlHistoryLimit(limit);

  const conditions = [
    eq(historicalObservations.entityType, "vault"),
    eq(historicalObservations.entityId, vaultId),
    eq(historicalObservations.metric, "tvl_usd"),
    // Excludes any observation workers/onchain/recheck-reorgs.ts has since
    // determined was reorged off the canonical chain - see
    // getPoolTvlHistory (queries/pools.ts) for the identical reasoning,
    // applied here to vaults.
    isNull(historicalObservations.reorgInvalidatedAt),
  ];
  if (since) conditions.push(gte(historicalObservations.timestamp, since));

  const recent = db
    .select({
      timestamp: historicalObservations.timestamp,
      value: historicalObservations.value,
      blockNumber: historicalObservations.blockNumber,
      blockHash: historicalObservations.blockHash,
      priceSource: historicalObservations.priceSource,
      priceRetrievedAt: historicalObservations.priceRetrievedAt,
      calculationInputs: historicalObservations.calculationInputs,
      source: historicalObservations.source,
      calculationVersion: historicalObservations.calculationVersion,
    })
    .from(historicalObservations)
    .where(and(...conditions))
    .orderBy(desc(historicalObservations.timestamp))
    .limit(normalizedLimit)
    .as("recent");

  const rows = await db.select().from(recent).orderBy(asc(recent.timestamp));

  return rows.map((r) => ({
    timestamp: r.timestamp,
    value: r.value,
    blockNumber: r.blockNumber != null ? Number(r.blockNumber) : null,
    blockHash: r.blockHash,
    priceSource: r.priceSource,
    priceRetrievedAt: r.priceRetrievedAt,
    calculationInputs: r.calculationInputs,
    source: r.source,
    calculationVersion: r.calculationVersion,
  }));
}

export async function getVaultObservationCount(vaultId: string): Promise<{ count: number; earliestAt: Date | null }> {
  const [row] = await db
    .select({ count: count(), earliest: min(historicalObservations.timestamp) })
    .from(historicalObservations)
    .where(
      and(
        eq(historicalObservations.entityType, "vault"),
        eq(historicalObservations.entityId, vaultId),
        eq(historicalObservations.metric, "tvl_usd"),
        isNull(historicalObservations.reorgInvalidatedAt),
      ),
    );

  return { count: row?.count ?? 0, earliestAt: row?.earliest ?? null };
}
