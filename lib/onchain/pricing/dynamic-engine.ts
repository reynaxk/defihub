import { type Address } from "viem";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { selectRotatingBatch } from "@/lib/indexing/rotation";
import { getIndexingState, updateIndexingState } from "@/lib/indexing/state";
import type { PriceSourceObservation } from "@/lib/database/schema";
import { PRICING_THRESHOLDS } from "./aggregate";
import { REFERENCE_ASSETS, type ReferenceAsset } from "./config";
import { findPricingCandidateEdges, pricingAddressKey, type PricingCandidateEdge } from "./dynamic-candidates";
import { buildReferenceAssetMulticallCalls, CALLS_PER_SOURCE_POOL, resolveReferenceAssetOutcome, type DecodedPoolReserves } from "./engine";
import { getNativeTokenPrice } from "./queries";
import { isNativePriceEligibleForTvl } from "./tvl-integration";
import type { PriceConfidence, PriceLabel } from "./types";

// Phase 5.13, Parts 2/3/9/10 - scales native pricing beyond the 7 hardcoded
// REFERENCE_ASSETS (config.ts) by dynamically discovering candidate pricing
// pools from the SAME live discovered-pool data the discovery pipeline
// already produces (dynamic-candidates.ts), instead of a human hand-adding
// config entries one at a time. Deliberately reuses, unmodified:
// buildReferenceAssetMulticallCalls (multicall batching), resolveReferenceAssetOutcome
// (the actual per-asset resolution decision - staleness/liquidity/outlier/
// confidence, ALL of it), aggregatePrices/classifyConfidence (inside that
// function), recordTokenPriceObservation (the write path), and
// selectRotatingBatch/indexingState (fairness). This file is the
// orchestration gluing them together for a dynamic candidate set, not a
// second pricing engine.
//
// CYCLE SAFETY BY CONSTRUCTION (Part 3): resolution proceeds hop-by-hop,
// strictly sequential, never in parallel. Hop 0 is the 7 hardcoded
// REFERENCE_ASSETS themselves - trusted unconditionally, exactly as today.
// Hop N only ever considers a candidate pool where EXACTLY ONE side is
// already in the trusted set built from hops 0..N-1 (findPricingCandidateEdges'
// own contract) - the OTHER side, by definition, is not yet trusted and
// cannot itself be used as a quote asset until (if ever) hop N successfully
// resolves it. A token can therefore only ever be assigned to the FIRST hop
// where it becomes reachable; once assigned, it is added to the trusted set
// and can never re-enter as an unresolved candidate on a later hop. This
// makes a genuine cycle (A priced from a pool paired against B, B priced
// from a pool paired against A) structurally unreachable - not merely
// detected and rejected after the fact, the way reference-graph.ts's
// resolveReferenceOrder guards the STATIC 7-asset graph (still used,
// unchanged, for that hop-0 resolution alone). MAX_PRICING_HOP_DEPTH
// (aggregate.ts) additionally bounds how many hops this engine will ever
// walk in one run, regardless: a token reachable only beyond that depth is
// left unpriced this run, never forced.
export const DYNAMIC_PRICING_ROTATION_COMPONENT = "native-pricing:dynamic-hop1";
// Bounded per-run batch - Part 10's "do not attempt to fully process every
// pool in a single request." Applied at hop 1 only (the overwhelming
// majority of real candidates - live-confirmed during Phase 5.12's own
// development, every discovered PancakeSwap V2 pool pairs its arbitrary
// token directly against a hop-0 reference asset). Hop 2+ candidates are
// naturally bounded by hop 1's own already-small batch (a hop-2 candidate
// can only exist paired against a token hop 1 JUST resolved this same run),
// so a second rotation cursor for it would bound something that's already
// bounded.
const CANDIDATES_PER_RUN = 40;

export interface DynamicPricingOutcome {
  key: string; // pricingAddressKey(chainSlug, address) - this token's own identity in this engine's trusted-set bookkeeping
  chainSlug: string;
  address: string;
  symbol: string | null;
  // Carried through so a caller writing a `tokens` row (ensureOnChainTokenRow,
  // price-dynamic-assets.ts) never needs to re-derive or guess it - the
  // exact same on-chain-verified value getActiveDiscoveredPools already
  // established at discovery-validation time (dynamic-candidates.ts).
  decimals: number;
  hop: number;
  ok: boolean;
  error?: string;
  priceUsd?: string;
  confidence?: PriceConfidence;
  label?: PriceLabel;
  sources?: PriceSourceObservation[];
  blockNumber?: bigint;
  blockHash?: string;
}

// A trusted token needs TWO things available to resolveReferenceAssetOutcome
// when it's used as a QUOTE asset (source.pairedWithKey) for some other
// candidate: its resolved USD price (priceByKey, used for the actual price
// derivation) AND its own ReferenceAsset record - address/decimals/symbol -
// which resolveReferenceAssetOutcome reads via `assetByKey.get(source.pairedWithKey)`
// (engine.ts) to know WHICH on-chain address/decimals the quote side even
// is. Bug fixed here (production bug report): resolveHop used to pass
// ONLY the candidate assets (groupEdgesByCandidate's own output) as
// `assetByKey` into resolveReferenceAssetOutcome - the trusted quote asset
// itself was never in that map, so `assetByKey.get(source.pairedWithKey)`
// always missed and every source was excluded as "not a known reference
// asset - config error," regardless of real liquidity. assetByKey must be
// the union of every candidate AND every trusted asset - see
// resolveHopOutcomes below, the one place that union is now built, and the
// only place this file constructs an assetByKey to hand to
// resolveReferenceAssetOutcome.
export interface TrustedSet {
  priceByKey: Map<string, string>;
  assetByKey: Map<string, ReferenceAsset>;
}

// Seeds the trusted set from the 7 hardcoded REFERENCE_ASSETS themselves -
// their prices are not re-derived here (that's priceReferenceAssetsOnChain's
// job, engine.ts, run separately/first in the same cron - see
// workers/onchain/price.ts), but every one of their own ReferenceAsset
// records IS always included in assetByKey unconditionally, mirroring
// priceReferenceAssetsOnChain's own assetByKey (engine.ts) exactly - it
// includes every configured asset regardless of whether pricing it actually
// succeeds. Whether a given asset's PRICE is trusted this run (priceByKey)
// is gated by the exact same isNativePriceEligibleForTvl bar (confidence
// MEDIUM+ AND fresh) the TVL engine already applies - a stale or LOW-
// confidence reference price must never be allowed to seed, and therefore
// silently compound into, a whole new tier of dynamically-derived prices.
// An asset present in assetByKey but absent from priceByKey correctly
// resolves any source quoting against it to "reference asset has not been
// resolved yet" (engine.ts) - excluded, never fabricated - rather than the
// misleading "not a known reference asset" outcome the bug produced.
async function seedTrustedSet(chainSlug: string, now: Date): Promise<TrustedSet> {
  const priceByKey = new Map<string, string>();
  const assetByKey = new Map<string, ReferenceAsset>();
  for (const asset of REFERENCE_ASSETS.filter((a) => a.chainSlug === chainSlug)) {
    const key = pricingAddressKey(chainSlug, asset.address);
    assetByKey.set(key, asset);
    const native = await getNativeTokenPrice(chainSlug, asset.address);
    if (native && isNativePriceEligibleForTvl(native.confidence, native.observedAt, now)) {
      priceByKey.set(key, native.priceUsd);
    }
  }
  return { priceByKey, assetByKey };
}

// The synthetic ReferenceAsset record for a candidate that just resolved
// successfully and was promoted into the trusted set - so a LATER hop can
// use it as a quote asset via the exact same assetByKey.get(pairedWithKey)
// lookup a hardcoded REFERENCE_ASSETS entry already gets. `sourcePools` is
// deliberately omitted/empty: this asset is already resolved (it needs no
// further pricing of its own), it's only ever looked up here as somebody
// ELSE's pairedAsset.
export function trustedAssetFromOutcome(outcome: DynamicPricingOutcome): ReferenceAsset {
  return {
    key: outcome.key,
    chainSlug: outcome.chainSlug,
    address: outcome.address,
    symbol: outcome.symbol ?? outcome.key,
    decimals: outcome.decimals,
    coingeckoId: "",
    kind: "derived",
    sourcePools: [],
  };
}

// Groups candidate edges by the token they'd price, so a token reachable
// via MULTIPLE independent pools gets ALL of them as sourcePools on one
// synthetic ReferenceAsset - Part 8's corroboration requirement, achieved
// by feeding resolveReferenceAssetOutcome/aggregatePrices exactly the same
// multi-source shape they already handle for REFERENCE_ASSETS' own
// multi-pool entries (e.g. wbtc-ethereum), never a bespoke corroboration
// algorithm.
export function groupEdgesByCandidate(edges: readonly PricingCandidateEdge[]): Map<string, ReferenceAsset> {
  const byKey = new Map<string, PricingCandidateEdge[]>();
  for (const edge of edges) {
    const key = pricingAddressKey(edge.chainSlug, edge.candidateAddress);
    const list = byKey.get(key) ?? [];
    list.push(edge);
    byKey.set(key, list);
  }

  const assetByKey = new Map<string, ReferenceAsset>();
  for (const [key, edgesForToken] of byKey) {
    const first = edgesForToken[0];
    assetByKey.set(key, {
      key,
      chainSlug: first.chainSlug,
      address: first.candidateAddress,
      symbol: first.candidateSymbol ?? key,
      decimals: first.candidateDecimals,
      coingeckoId: "", // no CoinGecko identity for a dynamically-discovered token - never read for a derived asset's own pricing, only anchors use it
      kind: "derived",
      sourcePools: edgesForToken.map((e) => ({ poolAddress: e.poolAddress, dexKind: e.dexKind, pairedWithKey: e.quoteAddressKey })),
    });
  }
  return assetByKey;
}

// Pure - given this hop's candidate assets, the full trusted set (both
// prices AND asset records - see TrustedSet's own comment above for why
// both are required), and already-decoded on-chain reserves, resolves every
// candidate's outcome. This is the ONE place resolveHop below (and this
// file's own regression tests) build the assetByKey handed to
// resolveReferenceAssetOutcome - deliberately extracted as its own pure,
// directly-testable function (no RPC, no DB - real decodedPools/trusted
// data can be hand-constructed exactly like engine.test.ts already does for
// resolveReferenceAssetOutcome itself) so this exact "forgot to include the
// trusted quote assets" orchestration bug has one single, tested assembly
// point rather than being free to recur at a second call site later.
export function resolveHopOutcomes(
  chainSlug: string,
  candidateAssetByKey: Map<string, ReferenceAsset>,
  trusted: TrustedSet,
  decodedPools: Map<string, DecodedPoolReserves>,
  now: Date,
  blockNumber: bigint,
  blockHash: string,
): DynamicPricingOutcome[] {
  // The union of every trusted (hop 0..N-1) asset and this hop's own
  // candidates - a candidate's own key never collides with a trusted key
  // (findPricingCandidateEdges' own contract: a candidate is, by
  // definition, not yet trusted), so ordering here doesn't matter, but
  // candidates are spread last so a genuine collision would still resolve
  // in the candidate's favor rather than silently reusing a stale trusted
  // entry.
  const fullAssetByKey = new Map<string, ReferenceAsset>([...trusted.assetByKey, ...candidateAssetByKey]);

  return [...candidateAssetByKey.values()].map((asset) => {
    const outcome = resolveReferenceAssetOutcome(asset, fullAssetByKey, decodedPools, trusted.priceByKey, now, blockNumber, blockHash, PRICING_THRESHOLDS.MIN_LIQUIDITY_USD_DYNAMIC);
    return {
      key: asset.key,
      chainSlug,
      address: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      hop: 0, // filled in by the caller, which knows which hop this call belongs to
      ok: outcome.ok,
      error: outcome.error,
      priceUsd: outcome.priceUsd,
      confidence: outcome.confidence,
      label: outcome.label,
      sources: outcome.sources,
      blockNumber: outcome.blockNumber,
      blockHash: outcome.blockHash,
    };
  });
}

// One hop's worth of chain reads + resolution, given the candidate assets to
// price this hop and the full trusted set to resolve them against. Mirrors
// priceReferenceAssetsOnChain's own block-pinning discipline exactly (same
// module, engine.ts, same withResilientClient/getBlockNumber/confirmations
// sequence) - every asset resolved THIS hop, on THIS chain, comes from the
// same pinned block.
async function resolveHop(
  chainSlug: string,
  candidateAssetByKey: Map<string, ReferenceAsset>,
  trusted: TrustedSet,
  now: Date,
): Promise<DynamicPricingOutcome[]> {
  const assets = [...candidateAssetByKey.values()];
  if (assets.length === 0) return [];

  const poolAddresses = [...new Set(assets.flatMap((a) => (a.sourcePools ?? []).map((p) => p.poolAddress.toLowerCase())))];
  const calls = buildReferenceAssetMulticallCalls(poolAddresses);

  const chainRead = await withResilientClient(chainSlug, async (client) => {
    const head = await client.getBlockNumber();
    const confirmations = confirmationsFor(chainSlug);
    const blockNumber = head > confirmations ? head - confirmations : BigInt(0);
    const [multicallResults, block] = await Promise.all([client.multicall({ contracts: calls, blockNumber }), client.getBlock({ blockNumber })]);
    return [multicallResults, blockNumber, block.hash] as const;
  }).catch((err) => ({ chainReadError: err instanceof Error ? err.message : String(err) }) as const);

  if ("chainReadError" in chainRead) {
    return assets.map((a) => ({ key: a.key, chainSlug, address: a.address, symbol: a.symbol, decimals: a.decimals, hop: 0, ok: false, error: `chain read failed: ${chainRead.chainReadError}` }));
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

  return resolveHopOutcomes(chainSlug, candidateAssetByKey, trusted, decodedPools, now, blockNumber, blockHash);
}

export interface DynamicPricingRunResult {
  outcomes: DynamicPricingOutcome[];
  candidatesConsidered: number;
}

// The entry point a worker calls, one chain at a time (mirrors
// priceReferenceAssetsOnChain's own per-chain granularity). Bounded,
// rotated, hop-by-hop - see this module's own header comment for the full
// cycle-safety argument.
export async function priceDynamicTokensOnChain(chainSlug: string, batchSize: number = CANDIDATES_PER_RUN): Promise<DynamicPricingRunResult> {
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) return { outcomes: [], candidatesConsidered: 0 };

  const now = new Date();
  const trusted = await seedTrustedSet(chainSlug, now);
  const outcomes: DynamicPricingOutcome[] = [];
  let candidatesConsidered = 0;

  const rotationState = await getIndexingState(chainSlug, DYNAMIC_PRICING_ROTATION_COMPONENT);
  let rotationOffset = rotationState?.lastProcessedBlock ?? BigInt(0);

  for (let hop = 1; hop <= PRICING_THRESHOLDS.MAX_PRICING_HOP_DEPTH; hop++) {
    // Candidate discovery stays keyed off priceByKey (not assetByKey): a
    // reference asset present in assetByKey but without a usable price this
    // run must not be treated as a valid quote for finding NEW candidates -
    // a candidate found only against it would just fail resolution anyway
    // (see seedTrustedSet's own comment), wasting a rotation slot.
    const edges = (await findPricingCandidateEdges(new Set(trusted.priceByKey.keys()))).filter((e) => e.chainSlug === chainSlug);
    let candidateAssetByKey = groupEdgesByCandidate(edges);

    if (hop === 1) {
      const candidateKeys = [...candidateAssetByKey.keys()];
      const selection = selectRotatingBatch(candidateKeys, batchSize, rotationOffset);
      rotationOffset = selection.nextOffset;
      const selectedKeys = new Set(selection.batch);
      candidateAssetByKey = new Map([...candidateAssetByKey].filter(([key]) => selectedKeys.has(key)));
    }

    candidatesConsidered += candidateAssetByKey.size;
    if (candidateAssetByKey.size === 0) continue;

    const hopOutcomes = await resolveHop(chainSlug, candidateAssetByKey, trusted, now);
    for (const outcome of hopOutcomes) {
      outcomes.push({ ...outcome, hop });
      // Promoted into the trusted set for the NEXT hop only when this run's
      // own resolution both succeeded AND cleared the same MEDIUM+ bar TVL
      // eligibility already requires (isNativePriceEligibleForTvl) - a LOW-
      // confidence or failed price is still recorded for auditability (see
      // price-dynamic-assets.ts) but never allowed to become another hop's
      // own trusted input, so a shaky price can never compound. Both maps
      // are updated together - a price with no matching asset record (or
      // vice versa) would silently reproduce this file's own reported bug
      // one hop later.
      if (outcome.ok && outcome.confidence && outcome.confidence !== "LOW" && outcome.confidence !== "INVALID") {
        trusted.priceByKey.set(outcome.key, outcome.priceUsd!);
        trusted.assetByKey.set(outcome.key, trustedAssetFromOutcome(outcome));
      }
    }

    if (hopOutcomes.some((o) => o.error?.startsWith("chain read failed"))) break; // a whole-hop chain-read failure - no new trusted prices to extend to a later hop with
  }

  await updateIndexingState(chainSlug, DYNAMIC_PRICING_ROTATION_COMPONENT, { lastProcessedBlock: rotationOffset, lastAttemptedSyncAt: now, status: "idle" });

  return { outcomes, candidatesConsidered };
}
