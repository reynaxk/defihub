import { sql } from "drizzle-orm";
import { parseAbi, type Address } from "viem";
import { db } from "@/lib/database/client";
import {
  historicalObservations,
  onchainVerifications,
  protocols,
  chains,
  type HistoricalObservationCalculationInput,
} from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { logger } from "@/lib/observability/logger";
import {
  computePoolTvl,
  priceToExactDecimalString,
  roundExactDecimal,
  VALID_BLOCK_HASH,
  type PoolTvlToken,
} from "./verify-pool";
import { VERIFIED_VAULTS, type VerifiedVault } from "./config";
import { syncVaultsFromConfig } from "./vaults";

// Phase 5.2: a genuinely reusable ERC-4626 adapter, structurally mirroring
// verify-pool.ts throughout (same block-pinning discipline, same
// block-hash-required historical_observations gate, same atomic
// verification+history write, same exact-arithmetic TVL calculation via
// computePoolTvl - imported and reused, not reimplemented). The only real
// difference from a pool is the on-chain read shape: one totalAssets() call
// against one underlying asset, instead of N balanceOf() calls across a
// pool's own tokens - everything downstream of that read (the arithmetic,
// the provenance, the idempotency, the reorg-recheck integration) is
// identical in kind to the pool path, which is exactly what makes this a
// reusable adapter rather than a one-off: onboarding another ERC-4626 vault
// is a VERIFIED_VAULTS config entry (lib/onchain/config.ts), not new code.

const TVL_CALCULATION_VERSION = "erc4626-total-assets-v1";
const VERIFICATION_DISPLAY_DECIMALS = 2;
const OBSERVATION_VALUE_DECIMALS = 8;

const VAULT_ABI = parseAbi(["function totalAssets() view returns (uint256)"]);

interface VaultOutcome {
  key: string;
  ok: boolean;
  error?: string;
  tvlUsd?: string; // exact decimal string - see computePoolTvl
  blockNumber?: bigint;
  blockHash?: string;
  calculationInputs?: HistoricalObservationCalculationInput[];
}

/**
 * Verifies every vault on a single chain in one batched round-trip: one
 * multicall covering every vault's totalAssets() read on this chain, plus
 * one getBlock. Mirrors verifyPoolsOnChain's exact batching/block-pinning
 * pattern (verify-pool.ts) - block number and hash are fetched once,
 * explicitly, and passed to the pinned multicall, rather than raced
 * concurrently against it, for the same reason: two independent JSON-RPC
 * calls can land on different blocks if one is mined in between, which
 * would make the persisted blockNumber not actually correspond to the
 * state that produced tvlUsd.
 */
async function verifyVaultsOnChain(
  chainSlug: string,
  vaultsOnChain: VerifiedVault[],
  priceById: Map<string, string>,
): Promise<VaultOutcome[]> {
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) {
    return vaultsOnChain.map((v) => ({ key: v.key, ok: false, error: `no RPC configured for chain "${chainSlug}"` }));
  }

  const calls = vaultsOnChain.map((v) => ({
    address: v.vaultAddress as Address,
    abi: VAULT_ABI,
    functionName: "totalAssets" as const,
  }));

  const chainRead = await withResilientClient(chainSlug, async (client) => {
    const head = await client.getBlockNumber();
    const confirmations = confirmationsFor(chainSlug);
    const blockNumber = head > confirmations ? head - confirmations : BigInt(0);
    const [multicallResults, block] = await Promise.all([
      client.multicall({ contracts: calls, blockNumber }),
      client.getBlock({ blockNumber }),
    ]);
    return [multicallResults, blockNumber, block.hash] as const;
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return { chainReadError: message } as const;
  });

  if ("chainReadError" in chainRead) {
    return vaultsOnChain.map((v) => ({ key: v.key, ok: false, error: `chain read failed: ${chainRead.chainReadError}` }));
  }
  const [multicallResults, blockNumber, blockHash] = chainRead;

  const outcomes: VaultOutcome[] = [];
  for (let i = 0; i < vaultsOnChain.length; i++) {
    const vault = vaultsOnChain[i];
    // A failed per-vault multicall result becomes `null`, never a
    // substituted/assumed value - computePoolTvl treats that as a hard
    // failure, same contract as a failed pool-token balanceOf.
    const totalAssets = multicallResults[i]?.status === "success" ? (multicallResults[i].result as bigint) : null;

    const token: PoolTvlToken = {
      symbol: vault.underlyingAsset.symbol,
      decimals: vault.underlyingAsset.decimals,
      coingeckoId: vault.underlyingAsset.coingeckoId,
    };
    // An ERC-4626 vault's TVL is exactly the N=1 case of "sum of balance *
    // price across the tokens this contract holds" - reusing
    // computePoolTvl unmodified is what makes this genuinely the same
    // exact-arithmetic engine, not a parallel reimplementation of it.
    const result = computePoolTvl([token], [totalAssets], priceById);

    if (!result.ok) {
      outcomes.push({ key: vault.key, ok: false, error: result.error });
      continue;
    }

    const calculationInputs: HistoricalObservationCalculationInput[] = [
      {
        symbol: token.symbol,
        coingeckoId: token.coingeckoId,
        decimals: token.decimals,
        balanceRaw: totalAssets!.toString(),
        priceUsd: priceById.get(token.coingeckoId)!,
      },
    ];

    outcomes.push({ key: vault.key, ok: true, tvlUsd: result.tvlUsd, blockNumber, blockHash, calculationInputs });
  }

  return outcomes;
}

export interface VaultVerificationRecord {
  vaultKey: string;
  protocolId: string | null;
  chainId: string;
  label: string;
  vaultAddress: string;
  tvlUsdForVerification: string;
  blockNumber: string;
  runTimestamp: Date;
  // null means "chain not yet synced into `vaults`" - skip the history
  // write, matching recordPoolVerification's own behavior for that case.
  vaultId: string | null;
  tvlUsdForObservation: string;
  blockHash: string | null;
  priceSource: string;
  priceRetrievedAt: Date;
  calculationInputs: HistoricalObservationCalculationInput[] | null;
  calculationVersion: string;
}

// The atomic write at the heart of recording one vault's verification -
// structurally identical to recordPoolVerification (verify-pool.ts): the
// upserted "latest value" (onchain_verifications) and the durable history
// row (historical_observations, entityType "vault") commit together, in one
// transaction, or neither does. The history write requires BOTH a vaultId
// and a genuinely valid blockHash (VALID_BLOCK_HASH, imported from
// verify-pool.ts rather than redefined) for the same reason pools require
// it: an observation without real block identity can't be checked against a
// reorg later. A skip is logged, never silent - see the else branch below.
export async function recordVaultVerification(record: VaultVerificationRecord): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(onchainVerifications)
      .values({
        key: record.vaultKey,
        protocolId: record.protocolId,
        chainId: record.chainId,
        label: record.label,
        poolAddress: record.vaultAddress,
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

    if (record.vaultId) {
      const hasValidBlockHash = record.blockHash != null && VALID_BLOCK_HASH.test(record.blockHash);

      if (hasValidBlockHash) {
        await tx
          .insert(historicalObservations)
          .values({
            chainId: record.chainId,
            entityType: "vault",
            entityId: record.vaultId,
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
          // Same partial-index target discipline as recordPoolVerification -
          // the "hash known" index always applies here since hasValidBlockHash
          // guarantees a real hash.
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
      } else {
        logger.warn("skipping native vault TVL historical observation - block hash unavailable or invalid", {
          component: "onchain",
          vaultKey: record.vaultKey,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash,
        });
      }
    }
  });
}

export async function verifyAllVaults(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  if (VERIFIED_VAULTS.length === 0) return [];

  const vaultIdByConfigKey = await syncVaultsFromConfig();

  const [protocolRows, chainRows] = await Promise.all([
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
  ]);
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const uniqueCoingeckoIds = [...new Set(VERIFIED_VAULTS.map((v) => v.underlyingAsset.coingeckoId))];
  let priceById: Map<string, string>;
  let priceRetrievedAt: Date;
  try {
    const prices = await priceProvider.getPrices(uniqueCoingeckoIds);
    priceRetrievedAt = new Date();
    priceById = new Map(prices.map((p) => [p.id, priceToExactDecimalString(p.priceUsd)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return VERIFIED_VAULTS.map((v) => ({ key: v.key, ok: false, error: `price lookup failed: ${message}` }));
  }

  const vaultsByChain = new Map<string, VerifiedVault[]>();
  for (const vault of VERIFIED_VAULTS) {
    const list = vaultsByChain.get(vault.chainSlug) ?? [];
    list.push(vault);
    vaultsByChain.set(vault.chainSlug, list);
  }

  const perChainOutcomes = await Promise.all(
    [...vaultsByChain.entries()].map(([chainSlug, vaultsOnChain]) => verifyVaultsOnChain(chainSlug, vaultsOnChain, priceById)),
  );
  const outcomeByKey = new Map(perChainOutcomes.flat().map((o) => [o.key, o]));

  const runTimestamp = new Date();

  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const vault of VERIFIED_VAULTS) {
    const outcome = outcomeByKey.get(vault.key);
    if (!outcome || !outcome.ok) {
      results.push({ key: vault.key, ok: false, error: outcome?.error ?? "no result" });
      continue;
    }

    const chainId = chainIdBySlug.get(vault.chainSlug);
    if (!chainId) {
      results.push({ key: vault.key, ok: false, error: `chain "${vault.chainSlug}" not found in DB` });
      continue;
    }

    const protocolId = protocolIdBySlug.get(vault.protocolDefillamaSlug) ?? null;
    const tvlUsdForVerification = roundExactDecimal(outcome.tvlUsd!, VERIFICATION_DISPLAY_DECIMALS);
    const tvlUsdForObservation = roundExactDecimal(outcome.tvlUsd!, OBSERVATION_VALUE_DECIMALS);
    const blockNumber = String(outcome.blockNumber!);

    try {
      await recordVaultVerification({
        vaultKey: vault.key,
        protocolId,
        chainId,
        label: vault.label,
        vaultAddress: vault.vaultAddress,
        tvlUsdForVerification,
        blockNumber,
        runTimestamp,
        vaultId: vaultIdByConfigKey.get(vault.key) ?? null,
        tvlUsdForObservation,
        blockHash: outcome.blockHash ?? null,
        priceSource: priceProvider.name,
        priceRetrievedAt,
        calculationInputs: outcome.calculationInputs ?? null,
        calculationVersion: TVL_CALCULATION_VERSION,
      });

      results.push({ key: vault.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: vault.key, ok: false, error: message });
    }
  }

  return results;
}
