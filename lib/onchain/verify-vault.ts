import { parseAbi, type Address } from "viem";
import { db } from "@/lib/database/client";
import { protocols, chains, type HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { logger } from "@/lib/observability/logger";
import { computePoolTvl, priceToExactDecimalString, roundExactDecimal, type PoolTvlToken } from "./verify-pool";
import { recordVerification } from "./record-verification";
import { vaultVerificationKey } from "./verification-key";
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

const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
]);

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
 *
 * Each vault contributes two calls to the same pinned multicall -
 * totalAssets() and asset() - not just the first. The config's own
 * underlyingAsset.address (lib/onchain/config.ts) is the *expected*
 * identity, confirmed by hand at config-authoring time (see each entry's
 * own comment); this on-chain asset() read is the ongoing, automatic check
 * that the vault's real identity hasn't drifted from what the config
 * claims - a compromised/upgraded/misconfigured vault contract, or a
 * config entry that was simply wrong, is caught here as an explicit
 * failure for that vault rather than silently computing TVL against the
 * wrong asset's price. Both reads are always in the SAME multicall/block
 * as each other and as the balance read they gate, never a separate,
 * later, potentially-different-block call.
 */
// Two calls per vault, always in this order (totalAssets() then asset()) -
// see CALLS_PER_VAULT below, which every result-index calculation is keyed
// off of. Both calls target the same vault address and are pushed into the
// same flat array that verifyVaultsOnChain sends as ONE multicall pinned to
// ONE block - extracted as its own pure function (no RPC involved) so this
// batching shape is directly testable without a live/mocked chain call; see
// verify-vault.test.ts.
export const CALLS_PER_VAULT = 2;

export function buildVaultMulticallCalls(vaultsOnChain: VerifiedVault[]) {
  return vaultsOnChain.flatMap((v) => [
    { address: v.vaultAddress as Address, abi: VAULT_ABI, functionName: "totalAssets" as const },
    { address: v.vaultAddress as Address, abi: VAULT_ABI, functionName: "asset" as const },
  ]);
}

// Pure, directly testable: whether a vault's live on-chain asset() result
// identifies the same underlying asset as its configured
// underlyingAsset.address. EVM addresses are not case-sensitive identity -
// the mixed-case form is an EIP-55 checksum encoding, not a distinct
// address - so this compares lowercased; a byte-for-byte comparison would
// wrongly reject a genuinely matching address purely because viem/the RPC
// node returned different capitalization than the config's own hand-typed
// value.
export function assetAddressMatchesConfig(onchainAssetAddress: string, configuredAddress: string): boolean {
  return onchainAssetAddress.toLowerCase() === configuredAddress.toLowerCase();
}

async function verifyVaultsOnChain(
  chainSlug: string,
  vaultsOnChain: VerifiedVault[],
  priceById: Map<string, string>,
): Promise<VaultOutcome[]> {
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) {
    return vaultsOnChain.map((v) => ({ key: v.key, ok: false, error: `no RPC configured for chain "${chainSlug}"` }));
  }

  const calls = buildVaultMulticallCalls(vaultsOnChain);

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
    const totalAssetsResult = multicallResults[i * CALLS_PER_VAULT];
    const assetResult = multicallResults[i * CALLS_PER_VAULT + 1];

    // A failed per-vault multicall result becomes `null`, never a
    // substituted/assumed value - computePoolTvl treats that as a hard
    // failure, same contract as a failed pool-token balanceOf.
    const totalAssets = totalAssetsResult?.status === "success" ? (totalAssetsResult.result as bigint) : null;
    const onchainAssetAddress = assetResult?.status === "success" ? (assetResult.result as Address) : null;

    if (onchainAssetAddress == null) {
      outcomes.push({ key: vault.key, ok: false, error: "asset() read failed" });
      continue;
    }
    if (!assetAddressMatchesConfig(onchainAssetAddress, vault.underlyingAsset.address)) {
      outcomes.push({
        key: vault.key,
        ok: false,
        error: `configured underlying asset ${vault.underlyingAsset.address} does not match this vault's on-chain asset() result ${onchainAssetAddress} - never substituted, config must be corrected`,
      });
      continue;
    }

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

// The atomic write at the heart of recording one vault's verification. The
// actual transaction logic lives in recordVerification (record-verification.ts)
// - shared with recordPoolVerification (verify-pool.ts), since the two were
// byte-for-byte identical except for which config/table each pulled its own
// identifiers from. This wrapper's job is entity-specific: namespace
// vaultKey via vaultVerificationKey (verification-key.ts) before it ever
// reaches the shared onchain_verifications.key namespace (see that
// function's own comment for why - a bare vault key could otherwise
// collide with a pool or protocol-TVL config key, and
// lib/onchain/config.ts's assertUniqueVerificationKeys validates every
// vault's *effective* key through this exact same function, so the two can
// never silently drift apart), and own this entity type's logging.
export async function recordVaultVerification(record: VaultVerificationRecord): Promise<void> {
  const outcome = await recordVerification({
    entityType: "vault",
    verificationKey: vaultVerificationKey(record.vaultKey),
    protocolId: record.protocolId,
    chainId: record.chainId,
    label: record.label,
    contractAddress: record.vaultAddress,
    tvlUsdForVerification: record.tvlUsdForVerification,
    blockNumber: record.blockNumber,
    runTimestamp: record.runTimestamp,
    entityId: record.vaultId,
    tvlUsdForObservation: record.tvlUsdForObservation,
    blockHash: record.blockHash,
    priceSource: record.priceSource,
    priceRetrievedAt: record.priceRetrievedAt,
    calculationInputs: record.calculationInputs,
    calculationVersion: record.calculationVersion,
  });

  if (outcome === "skipped-invalid-hash") {
    logger.warn("skipping native vault TVL historical observation - block hash unavailable or invalid", {
      component: "onchain",
      vaultKey: record.vaultKey,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
    });
  }
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
