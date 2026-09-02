import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { pools, type HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { logger } from "@/lib/observability/logger";
import { getExternalTokenPrice, isExternalTokenPriceFresh } from "../pricing/external-token-price";
import { getNativeTokenPrice } from "../pricing/queries";
import { isNativePriceEligibleForTvl, priceLabelForTokens, priceSourceForTokens, type NativePriceOverride } from "../pricing/tvl-integration";
import { recordPoolVerification, roundExactDecimal, verifyPoolsOnChain } from "../verify-pool";
import type { VerifiedPool, VerifiedPoolToken } from "../config";
import { discoveredPoolConfigKey } from "./register";
import { getActiveDiscoveredPools, type ActiveDiscoveredPool } from "./queries";

// Phase 5.12, Part 3 - the ONLY new thing this file adds is WHICH pools get
// verified and HOW each token's price is resolved. Every other step -
// on-chain balance reads, the pinned-block multicall, the exact TVL math,
// the atomic onchain_verifications+historical_observations write, the
// reorg-safe block-hash provenance - is verifyPoolsOnChain/
// recordPoolVerification (verify-pool.ts) reused verbatim. This is
// deliberately NOT a second TVL engine.
//
// The one real wrinkle: verifyPoolsOnChain's `priceById` map (and the
// calculationInputs it builds) is keyed by `VerifiedPoolToken.coingeckoId`,
// because VERIFIED_POOLS tokens always have a real one. A discovered pool's
// tokens virtually never do (register.ts leaves poolTokens.coingeckoId
// null) - so this file passes each token's own lowercased on-chain ADDRESS
// as that key instead. verifyPoolsOnChain only ever treats it as an opaque
// correlation key (never validates it as a real CoinGecko id), so this is
// safe - but it means the RAW outcome.calculationInputs coming back has
// "coingeckoId" holding an address, which would be dishonest provenance if
// persisted as-is. honestifyCalculationInputs below is the translation
// step: replace that synthetic value with either the REAL coingeckoId (a
// token externally priced via one) or move it to the new tokenAddress
// field (schema.ts) and attach real nativePriceProvenance (a natively
// priced token) - see HistoricalObservationCalculationInput's own comment
// for why both identity fields exist as of this phase.

const TVL_CALCULATION_VERSION = "pool-balance-sum-v1"; // identical methodology to verify-pool.ts - same version tag on purpose
const VERIFICATION_DISPLAY_DECIMALS = 2;
const OBSERVATION_VALUE_DECIMALS = 8;

export type ResolvedTokenPrice = { priceUsd: string; kind: "native"; nativeOverride: NativePriceOverride } | { priceUsd: string; kind: "external"; coingeckoId: string };

// Resolves ONE token's price using the exact same two-tier policy
// verify-pool.ts's resolveNativePriceOverrides already established for
// VERIFIED_POOLS: prefer a confident, fresh native reference-asset price;
// otherwise fall back to the already-synced external price for this exact
// on-chain address, if this codebase's own token-discovery sync has ever
// resolved one; otherwise genuinely unavailable. Never guesses, never
// calls a live external API (see external-token-price.ts's own module
// comment). Exported for its own direct integration test - a real-DB,
// RPC-free decision, the same "isolate the piece that doesn't need a
// mocked chain client" precedent verify-pool.ts's own pure-function-only
// test file already establishes for this whole TVL engine.
export async function resolveDiscoveredTokenPrice(chainSlug: string, address: string, now: Date): Promise<ResolvedTokenPrice | null> {
  const native = await getNativeTokenPrice(chainSlug, address);
  if (native && isNativePriceEligibleForTvl(native.confidence, native.observedAt, now)) {
    return {
      priceUsd: native.priceUsd,
      kind: "native",
      nativeOverride: { priceUsd: native.priceUsd, sources: native.sources, observedAt: native.observedAt, blockNumber: native.blockNumber, blockHash: native.blockHash },
    };
  }

  const external = await getExternalTokenPrice(chainSlug, address);
  if (external && isExternalTokenPriceFresh(external.observedAt, now)) {
    return { priceUsd: external.priceUsd, kind: "external", coingeckoId: external.coingeckoId };
  }

  return null;
}

interface EligiblePool {
  pool: ActiveDiscoveredPool;
  configKey: string;
  poolId: string;
  protocolId: string | null;
  chainId: string;
  label: string;
  verifiedPool: VerifiedPool;
  token0Key: string;
  token1Key: string;
  price0: ResolvedTokenPrice;
  price1: ResolvedTokenPrice;
}

export interface DiscoveredPoolTvlOutcome {
  key: string;
  ok: boolean;
  error?: string;
}

// The Part 3 entry point - the discovered-pool twin of verifyAllPools
// (verify-pool.ts). Wired into workers/onchain/verify.ts alongside the
// existing verifyAllPools/verifyAllProtocolTvls/verifyAllVaults calls, not
// a separate cron/worker - Section 22's "reuse existing... primitives"
// applies to the scheduling surface too, not just the calculation code.
export async function verifyDiscoveredPoolsTvl(): Promise<DiscoveredPoolTvlOutcome[]> {
  const activePools = await getActiveDiscoveredPools();
  if (activePools.length === 0) return [];

  const now = new Date();
  const eligible: EligiblePool[] = [];
  const results: DiscoveredPoolTvlOutcome[] = [];

  for (const pool of activePools) {
    const configKey = discoveredPoolConfigKey(pool.chainSlug, pool.poolAddress);

    // A registered discovered pool always has a `pools` row (that's what
    // "registered" means - see register.ts) - but this is still a real DB
    // read, not an assumption, and a pool somehow missing one (a genuine
    // data-integrity bug, not a normal case) is skipped rather than
    // crashing the whole run, matching verifyAllPools' own "poolId null ->
    // skip" tolerance for its analogous case.
    const [poolRow] = await db
      .select({ id: pools.id, protocolId: pools.protocolId, chainId: pools.chainId, label: pools.label })
      .from(pools)
      .where(eq(pools.configKey, configKey));
    if (!poolRow) {
      results.push({ key: configKey, ok: false, error: "no registered pools row for this configKey - cannot record a native TVL observation without one" });
      continue;
    }

    const token0Key = pool.token0Address.toLowerCase();
    const token1Key = pool.token1Address.toLowerCase();
    const [price0, price1] = await Promise.all([
      resolveDiscoveredTokenPrice(pool.chainSlug, pool.token0Address, now),
      resolveDiscoveredTokenPrice(pool.chainSlug, pool.token1Address, now),
    ]);

    // Both tokens need SOME price to compute a TVL at all - see
    // computePoolTvl's own contract (a missing price is always an
    // explicit failure, never a $0 substitution). Never even attempt the
    // on-chain balance read for a pool that can't possibly produce a real
    // number - that would just be a wasted RPC call for a guaranteed
    // "unavailable" outcome.
    if (!price0 || !price1) {
      const missing = [!price0 ? (pool.token0Symbol ?? pool.token0Address) : null, !price1 ? (pool.token1Symbol ?? pool.token1Address) : null].filter(Boolean);
      results.push({ key: configKey, ok: false, error: `native TVL unavailable - no reliable price for ${missing.join(" or ")}` });
      continue;
    }

    const tokens: VerifiedPoolToken[] = [
      { address: pool.token0Address, symbol: pool.token0Symbol ?? "UNKNOWN", decimals: pool.token0Decimals, coingeckoId: token0Key },
      { address: pool.token1Address, symbol: pool.token1Symbol ?? "UNKNOWN", decimals: pool.token1Decimals, coingeckoId: token1Key },
    ];

    eligible.push({
      pool,
      configKey,
      poolId: poolRow.id,
      protocolId: poolRow.protocolId,
      chainId: poolRow.chainId,
      label: poolRow.label,
      verifiedPool: {
        key: configKey,
        chainSlug: pool.chainSlug,
        protocolDefillamaSlug: "", // unused by verifyPoolsOnChain itself
        label: poolRow.label,
        poolAddress: pool.poolAddress,
        tokens,
      },
      token0Key,
      token1Key,
      price0,
      price1,
    });
  }

  if (eligible.length === 0) return results;

  const poolsByChain = new Map<string, EligiblePool[]>();
  for (const e of eligible) {
    const list = poolsByChain.get(e.pool.chainSlug) ?? [];
    list.push(e);
    poolsByChain.set(e.pool.chainSlug, list);
  }

  const runTimestamp = now;

  for (const [chainSlug, poolsOnChain] of poolsByChain) {
    // priceById is keyed by the SAME per-token address key every eligible
    // pool on this chain used above - built once per chain from the
    // already-resolved prices, never re-queried. Two different pools can
    // legitimately share a token (e.g. two pools both pairing something
    // against WBNB) - the map naturally dedupes that, and the price is
    // identical either way since it came from the same underlying
    // observation.
    const priceById = new Map<string, string>();
    for (const e of poolsOnChain) {
      priceById.set(e.token0Key, e.price0.priceUsd);
      priceById.set(e.token1Key, e.price1.priceUsd);
    }

    const outcomes = await verifyPoolsOnChain(
      chainSlug,
      poolsOnChain.map((e) => e.verifiedPool),
      priceById,
    );
    const outcomeByKey = new Map(outcomes.map((o) => [o.key, o]));

    for (const e of poolsOnChain) {
      const outcome = outcomeByKey.get(e.configKey);
      if (!outcome || !outcome.ok) {
        results.push({ key: e.configKey, ok: false, error: outcome?.error ?? "no result" });
        continue;
      }

      const nativeOverrideByKey = new Map<string, NativePriceOverride>();
      const externalCoingeckoIdByKey = new Map<string, string>();
      for (const [key, price] of [
        [e.token0Key, e.price0],
        [e.token1Key, e.price1],
      ] as const) {
        if (price.kind === "native") nativeOverrideByKey.set(key, price.nativeOverride);
        else externalCoingeckoIdByKey.set(key, price.coingeckoId);
      }

      const honestCalculationInputs = honestifyCalculationInputs(outcome.calculationInputs ?? [], nativeOverrideByKey, externalCoingeckoIdByKey);
      const tokenKeys = [e.token0Key, e.token1Key];
      const nativelyPricedKeys = new Set(nativeOverrideByKey.keys());
      const priceSource = priceSourceForTokens(tokenKeys, nativelyPricedKeys, priceProvider.name);
      const priceLabel = priceLabelForTokens(tokenKeys, nativelyPricedKeys);

      const tvlUsdForVerification = roundExactDecimal(outcome.tvlUsd!, VERIFICATION_DISPLAY_DECIMALS);
      const tvlUsdForObservation = roundExactDecimal(outcome.tvlUsd!, OBSERVATION_VALUE_DECIMALS);

      try {
        await recordPoolVerification({
          poolKey: e.configKey,
          protocolId: e.protocolId,
          chainId: e.chainId,
          label: e.label,
          poolAddress: e.pool.poolAddress,
          tvlUsdForVerification,
          blockNumber: String(outcome.blockNumber!),
          runTimestamp,
          poolId: e.poolId,
          tvlUsdForObservation,
          blockHash: outcome.blockHash ?? null,
          priceSource,
          priceLabel,
          priceRetrievedAt: now,
          calculationInputs: honestCalculationInputs,
          calculationVersion: TVL_CALCULATION_VERSION,
        });
        results.push({ key: e.configKey, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("native discovered-pool TVL write failed", { component: "onchain-discovery", pool: e.configKey, error: message });
        results.push({ key: e.configKey, ok: false, error: message });
      }
    }
  }

  return results;
}

// Pure - translates verifyPoolsOnChain's raw calculationInputs (whose
// `coingeckoId` field, for a discovered pool, actually holds the
// lowercased on-chain address used as this run's correlation key - see
// this file's own module comment) into honest, persistable provenance:
// - a natively-priced token gets tokenAddress set, coingeckoId cleared,
//   and its real nativePriceProvenance attached - the same shape
//   attachNativeProvenance (verify-pool.ts) already establishes for
//   VERIFIED_POOLS, just keyed by address here instead of coingeckoId.
// - an externally-priced token gets tokenAddress set AND its real
//   coingeckoId restored (never left holding the synthetic address key).
// A token matching neither map is unreachable in practice (every entry
// here came from a pool that only proceeded past the eligibility check in
// verifyDiscoveredPoolsTvl because BOTH tokens resolved to one kind or the
// other) - defensively left with tokenAddress only, never fabricated.
export function honestifyCalculationInputs(
  rawInputs: readonly HistoricalObservationCalculationInput[],
  nativeOverrideByKey: ReadonlyMap<string, NativePriceOverride>,
  externalCoingeckoIdByKey: ReadonlyMap<string, string>,
): HistoricalObservationCalculationInput[] {
  return rawInputs.map((input) => {
    const key = input.coingeckoId; // the synthetic address-as-key this run's caller used
    const { coingeckoId: _synthetic, nativePriceProvenance: _discard, ...rest } = input;
    void _synthetic;
    void _discard;

    const nativeOverride = key != null ? nativeOverrideByKey.get(key) : undefined;
    if (nativeOverride) {
      return {
        ...rest,
        tokenAddress: key,
        nativePriceProvenance: {
          sources: nativeOverride.sources,
          observedAt: nativeOverride.observedAt.toISOString(),
          blockNumber: nativeOverride.blockNumber,
          blockHash: nativeOverride.blockHash,
        },
      };
    }

    const realCoingeckoId = key != null ? externalCoingeckoIdByKey.get(key) : undefined;
    return { ...rest, tokenAddress: key, coingeckoId: realCoingeckoId };
  });
}
