import { type Address } from "viem";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import type { PriceSourceObservation } from "@/lib/database/schema";
import { aggregatePrices, PRICING_THRESHOLDS, type AggregationInput } from "./aggregate";
import { REFERENCE_ASSETS, toReferenceAssetNode, type ReferenceAsset, type ReferenceAssetSourcePool } from "./config";
import { resolveReferenceOrder } from "./reference-graph";
import { V2_PAIR_ABI, deriveV2Price } from "./uniswap-v2";
import type { CandidatePriceSource, PriceConfidence, PriceLabel } from "./types";

// Three calls per source pool, always in this order (getReserves, token0,
// token1) - mirrors verify-vault.ts's CALLS_PER_VAULT convention exactly
// (same reasoning: every result-index calculation is keyed off this
// constant, and it's exported so buildReferenceAssetMulticallCalls' own
// batching shape is directly testable without a live/mocked chain call).
export const CALLS_PER_SOURCE_POOL = 3;

export function buildReferenceAssetMulticallCalls(poolAddresses: readonly string[]) {
  return poolAddresses.flatMap((address) => [
    { address: address as Address, abi: V2_PAIR_ABI, functionName: "getReserves" as const },
    { address: address as Address, abi: V2_PAIR_ABI, functionName: "token0" as const },
    { address: address as Address, abi: V2_PAIR_ABI, functionName: "token1" as const },
  ]);
}

export interface DecodedPoolReserves {
  reserve0: bigint | null;
  reserve1: bigint | null;
  token0: Address | null;
  token1: Address | null;
}

export interface ReferenceAssetOutcome {
  key: string;
  ok: boolean;
  error?: string;
  priceUsd?: string;
  confidence?: PriceConfidence;
  label?: PriceLabel;
  sources?: PriceSourceObservation[];
  blockNumber?: bigint;
  blockHash?: string;
}

// Pure - the full per-asset resolution (anchor short-circuit, or per-source-
// pool decode/match/derive, then aggregation) given already-decoded
// multicall results and every dependency's already-resolved price. No RPC
// call of its own, following this codebase's established pattern
// (resolveVaultOutcome in verify-vault.ts is the direct precedent this
// mirrors) specifically so every branch - a pool's token0/token1 not
// matching the configured pair, a zero-reserve pool, an outlier source, a
// dependency that failed to resolve - is directly unit-testable with plain
// constructed inputs, never a mocked RPC client.
export function resolveReferenceAssetOutcome(
  asset: ReferenceAsset,
  assetByKey: Map<string, ReferenceAsset>,
  decodedPools: Map<string, DecodedPoolReserves>,
  resolvedPriceByKey: Map<string, string>,
  now: Date,
  blockNumber: bigint,
  blockHash: string,
): ReferenceAssetOutcome {
  if (asset.kind === "anchor") {
    return {
      key: asset.key,
      ok: true,
      priceUsd: asset.anchorPriceUsd!,
      // MEDIUM, deliberately never HIGH: an anchor's price is hand-declared
      // (see config.ts's own header comment for why some starting point is
      // unavoidable), not independently corroborated by multiple on-chain
      // sources the way a genuinely "derived" asset's HIGH confidence
      // requires (see classifyConfidence, aggregate.ts) - MEDIUM honestly
      // reflects "trustworthy by design, not proven fresh every run,"
      // rather than overstating it as HIGH or unfairly understating it as
      // LOW for what is, in practice, one of the deepest, most scrutinized
      // dollar-pegged assets in DeFi.
      confidence: "MEDIUM",
      label: "ONCHAIN_NATIVE",
      sources: [],
      blockNumber,
      blockHash,
    };
  }

  const sourcePools = asset.sourcePools ?? [];
  if (sourcePools.length === 0) {
    return { key: asset.key, ok: false, error: "derived reference asset has no configured source pools" };
  }

  const preExcluded: PriceSourceObservation[] = [];
  const candidateInputs: AggregationInput[] = [];

  // Every configured source pool is evaluated independently - one source's
  // failure (an unknown paired asset, an unresolved dependency, a chain
  // read failure, a pair mismatch, an unusable derived price) excludes only
  // that source and records why, then moves on to the next one. It must
  // never abort evaluation of the OTHER configured sources for this same
  // asset: a genuinely valid source sitting right next to a broken one
  // would otherwise be thrown away along with it. The asset as a whole only
  // fails once every source has been excluded (see the aggregatePrices call
  // below, which returns INVALID exactly when candidateInputs ends up
  // empty) - that's the one case where "no valid source" really is the
  // asset's own outcome, not a false negative from one bad source.
  for (const source of sourcePools) {
    const pairedAsset = assetByKey.get(source.pairedWithKey);
    if (!pairedAsset) {
      // Genuinely unknown on every axis - there's no real ReferenceAsset to
      // pull a symbol/address from, so pairedTokenSymbol carries the raw
      // config key itself (more useful for debugging than a bare
      // "unknown") rather than a value invented to fit the normal shape.
      preExcluded.push({
        sourceKind: source.dexKind,
        sourcePoolAddress: source.poolAddress,
        sourceChainSlug: asset.chainSlug,
        pairedTokenSymbol: source.pairedWithKey,
        pairedTokenAddress: "unknown",
        pairedTokenPriceUsd: "0",
        priceUsd: "0",
        liquidityUsd: "0",
        reserveRaw: "0",
        pairedReserveRaw: "0",
        included: false,
        exclusionReason: `configured pairedWithKey "${source.pairedWithKey}" is not a known reference asset - config error`,
      });
      continue;
    }
    const pairedPriceUsd = resolvedPriceByKey.get(source.pairedWithKey);
    if (pairedPriceUsd == null) {
      // Should be unreachable in production (engine.ts's caller always
      // processes assets in resolveReferenceOrder's dependency order), but
      // never assumed - an asset priced against an unresolved reference
      // would silently be wrong, not just incomplete. The reserves
      // genuinely haven't been evaluated against this source yet, so they
      // stay unknown too - only the paired asset's identity is known here.
      preExcluded.push(
        excludedSourceObservation(source, asset, pairedAsset, `reference asset "${source.pairedWithKey}" has not been resolved yet - dependency ordering bug`),
      );
      continue;
    }

    const decoded = decodedPools.get(source.poolAddress.toLowerCase());
    if (!decoded || decoded.token0 == null || decoded.token1 == null || decoded.reserve0 == null || decoded.reserve1 == null) {
      preExcluded.push(
        excludedSourceObservation(source, asset, pairedAsset, "on-chain read failed (getReserves()/token0()/token1())"),
      );
      continue;
    }

    const assetAddr = asset.address.toLowerCase();
    const pairedAddr = pairedAsset.address.toLowerCase();
    const token0 = decoded.token0.toLowerCase();
    const token1 = decoded.token1.toLowerCase();

    let pricedReserve: bigint;
    let pairedReserve: bigint;
    if (token0 === assetAddr && token1 === pairedAddr) {
      pricedReserve = decoded.reserve0;
      pairedReserve = decoded.reserve1;
    } else if (token1 === assetAddr && token0 === pairedAddr) {
      pricedReserve = decoded.reserve1;
      pairedReserve = decoded.reserve0;
    } else {
      // The pool's own on-chain token0()/token1() don't match this config
      // entry's declared pair at all - never trusted, never substituted;
      // this source is excluded with a clear, specific reason, the same
      // "config is the expected value, chain validates it, never the
      // reverse" discipline verify-vault.ts's asset() check established.
      // The reserves themselves WERE read successfully though - recorded
      // here in raw token0/token1 order (not asset/paired order, which is
      // exactly the thing this branch couldn't determine) rather than
      // discarded, since "what did the chain actually return" remains
      // known even though this source can't be trusted to price anything.
      preExcluded.push(
        excludedSourceObservation(
          source,
          asset,
          pairedAsset,
          `pool token0/token1 (${decoded.token0}/${decoded.token1}) do not match the configured pair (${asset.address}/${pairedAsset.address})`,
          { pairedTokenPriceUsd: pairedPriceUsd, reserveRaw: decoded.reserve0.toString(), pairedReserveRaw: decoded.reserve1.toString() },
        ),
      );
      continue;
    }

    const derived = deriveV2Price({
      pricedReserve,
      pricedDecimals: asset.decimals,
      pairedReserve,
      pairedDecimals: pairedAsset.decimals,
      pairedPriceUsd,
      minLiquidityUsd: PRICING_THRESHOLDS.MIN_LIQUIDITY_USD,
    });

    if (!derived.ok) {
      // deriveV2Price itself couldn't produce a price/liquidity (e.g. below
      // the minimum-liquidity floor) - genuinely unknown, never fabricated.
      // The reserves and the paired price that were fed into it are known
      // though, and preserved here rather than zeroed alongside them.
      preExcluded.push(
        excludedSourceObservation(source, asset, pairedAsset, derived.error, {
          pairedTokenPriceUsd: pairedPriceUsd,
          reserveRaw: pricedReserve.toString(),
          pairedReserveRaw: pairedReserve.toString(),
        }),
      );
      continue;
    }

    const candidate: CandidatePriceSource = {
      sourceKind: source.dexKind,
      sourcePoolAddress: source.poolAddress,
      sourceChainSlug: asset.chainSlug,
      pairedTokenSymbol: pairedAsset.symbol,
      pairedTokenAddress: pairedAsset.address,
      pairedTokenPriceUsd: pairedPriceUsd,
      priceUsd: derived.priceUsd,
      liquidityUsd: derived.liquidityUsd,
      reserveRaw: pricedReserve.toString(),
      pairedReserveRaw: pairedReserve.toString(),
    };
    candidateInputs.push({ candidate, observedAt: now });
  }

  const aggregated = aggregatePrices(candidateInputs, now, "ONCHAIN_NATIVE");
  const sources = [...preExcluded, ...aggregated.sources];

  if (aggregated.confidence === "INVALID") {
    return { key: asset.key, ok: false, error: "no valid on-chain price source produced a usable price this run", sources };
  }

  return {
    key: asset.key,
    ok: true,
    priceUsd: aggregated.priceUsd,
    confidence: aggregated.confidence,
    label: aggregated.label,
    sources,
    blockNumber,
    blockHash,
  };
}

// Builds an excluded-source observation, preserving whatever inputs were
// genuinely known at the point of exclusion rather than zeroing everything
// out uniformly. `known` covers exactly the fields that can legitimately
// be known even though the source itself is excluded (the paired asset's
// USD price, and the raw reserves the chain actually returned) - anything
// not passed in `known` stays "0", meaning it truly is unknown (e.g. a
// chain read that failed outright has no reserves to report at all).
// "Known but excluded" and "unknown" are deliberately never conflated: a
// consumer reading calculation_inputs later must be able to tell them
// apart, not see an indistinguishable "0" for both.
function excludedSourceObservation(
  source: ReferenceAssetSourcePool,
  asset: ReferenceAsset,
  pairedAsset: ReferenceAsset,
  reason: string,
  known: Partial<Pick<PriceSourceObservation, "pairedTokenPriceUsd" | "reserveRaw" | "pairedReserveRaw">> = {},
): PriceSourceObservation {
  return {
    sourceKind: source.dexKind,
    sourcePoolAddress: source.poolAddress,
    sourceChainSlug: asset.chainSlug,
    pairedTokenSymbol: pairedAsset.symbol,
    pairedTokenAddress: pairedAsset.address,
    pairedTokenPriceUsd: known.pairedTokenPriceUsd ?? "0",
    priceUsd: "0",
    liquidityUsd: "0",
    reserveRaw: known.reserveRaw ?? "0",
    pairedReserveRaw: known.pairedReserveRaw ?? "0",
    included: false,
    exclusionReason: reason,
  };
}

// Prices every configured reference asset on one chain in a single batched
// round-trip: one multicall covering every source pool's getReserves()/
// token0()/token1(), plus one getBlock - the exact block-pinning discipline
// verifyPoolsOnChain/verifyVaultsOnChain already established (see their own
// module comments): getBlockNumber() fetched first and sequentially, then
// multicall+getBlock concurrently against that already-pinned height, all
// inside one withResilientClient invocation so a retry/failover restarts
// the whole sequence together. Every reference asset on this chain is
// therefore priced from exactly the same block - which is what makes
// per-asset provenance (blockNumber/blockHash) meaningful even though
// several assets' prices may each depend on another asset's just-resolved
// price within this same call.
export async function priceReferenceAssetsOnChain(chainSlug: string): Promise<ReferenceAssetOutcome[]> {
  const assetsOnChain = REFERENCE_ASSETS.filter((a) => a.chainSlug === chainSlug);
  if (assetsOnChain.length === 0) return [];

  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) {
    return assetsOnChain.map((a) => ({ key: a.key, ok: false, error: `no RPC configured for chain "${chainSlug}"` }));
  }

  const assetByKey = new Map(assetsOnChain.map((a) => [a.key, a]));
  let orderedAssets: ReferenceAsset[];
  try {
    orderedAssets = resolveReferenceOrder(assetsOnChain.map(toReferenceAssetNode)).map((n) => assetByKey.get(n.key)!);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return assetsOnChain.map((a) => ({ key: a.key, ok: false, error: `reference asset dependency resolution failed: ${message}` }));
  }

  const poolAddresses = [
    ...new Set(assetsOnChain.flatMap((a) => (a.sourcePools ?? []).map((p) => p.poolAddress.toLowerCase()))),
  ];
  const calls = buildReferenceAssetMulticallCalls(poolAddresses);

  const chainRead =
    calls.length === 0
      ? await withResilientClient(chainSlug, async (client) => {
          const head = await client.getBlockNumber();
          const confirmations = confirmationsFor(chainSlug);
          const blockNumber = head > confirmations ? head - confirmations : BigInt(0);
          const block = await client.getBlock({ blockNumber });
          return [[], blockNumber, block.hash] as const;
        }).catch((err) => ({ chainReadError: err instanceof Error ? err.message : String(err) }) as const)
      : await withResilientClient(chainSlug, async (client) => {
          const head = await client.getBlockNumber();
          const confirmations = confirmationsFor(chainSlug);
          const blockNumber = head > confirmations ? head - confirmations : BigInt(0);
          const [multicallResults, block] = await Promise.all([
            client.multicall({ contracts: calls, blockNumber }),
            client.getBlock({ blockNumber }),
          ]);
          return [multicallResults, blockNumber, block.hash] as const;
        }).catch((err) => ({ chainReadError: err instanceof Error ? err.message : String(err) }) as const);

  if ("chainReadError" in chainRead) {
    return assetsOnChain.map((a) => ({ key: a.key, ok: false, error: `chain read failed: ${chainRead.chainReadError}` }));
  }
  const [multicallResults, blockNumber, blockHash] = chainRead;

  const decodedPools = new Map<string, DecodedPoolReserves>();
  poolAddresses.forEach((address, i) => {
    const reservesResult = multicallResults[i * CALLS_PER_SOURCE_POOL];
    const token0Result = multicallResults[i * CALLS_PER_SOURCE_POOL + 1];
    const token1Result = multicallResults[i * CALLS_PER_SOURCE_POOL + 2];
    const reserves = reservesResult?.status === "success" ? (reservesResult.result as readonly [bigint, bigint, number]) : null;
    decodedPools.set(address, {
      reserve0: reserves ? reserves[0] : null,
      reserve1: reserves ? reserves[1] : null,
      token0: token0Result?.status === "success" ? (token0Result.result as Address) : null,
      token1: token1Result?.status === "success" ? (token1Result.result as Address) : null,
    });
  });

  const now = new Date();
  const resolvedPriceByKey = new Map<string, string>();
  const outcomes: ReferenceAssetOutcome[] = [];

  // Processed strictly in dependency order (resolveReferenceOrder above) -
  // an asset's own source pools are only ever read against an already-
  // resolved reference price, never an unresolved or later one.
  for (const asset of orderedAssets) {
    const outcome = resolveReferenceAssetOutcome(asset, assetByKey, decodedPools, resolvedPriceByKey, now, blockNumber, blockHash);
    outcomes.push(outcome);
    if (outcome.ok) resolvedPriceByKey.set(asset.key, outcome.priceUsd!);
    // A failed reference asset's price is never substituted or assumed for
    // any asset depending on it - that dependent will itself fail with
    // "dependency ordering bug"/missing-price above when its own turn
    // comes, rather than silently pricing against nothing.
  }

  return outcomes;
}
