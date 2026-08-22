import { eq } from "drizzle-orm";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
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
import { VERIFIED_POOLS, type VerifiedPool } from "./config";
import { syncPoolsFromConfig } from "./pools";

// Bumped only if the sum-of-balances methodology itself changes (e.g. a
// future AMM adapter that isn't "sum this contract's own ERC-20 balances")
// - lets historical_observations distinguish figures computed one way from
// figures computed another, rather than silently mixing them in one series.
const TVL_CALCULATION_VERSION = "pool-balance-sum-v1";

// onchain_verifications.tvl_usd is numeric(24,2) - an existing, working
// column this function doesn't own the contract for. Rounding to this
// precision only at the point of insertion (never earlier, inside the
// calculation itself) keeps that table's existing shape while not
// constraining what historical_observations.value (numeric(32,8), below)
// is allowed to keep.
const VERIFICATION_DISPLAY_DECIMALS = 2;
// historical_observations.value is numeric(32,8) - formatting to this
// many decimals (not VERIFICATION_DISPLAY_DECIMALS' 2) is what actually
// preserves a sub-cent TVL contribution instead of silently flooring it
// to $0.00 before it's ever written.
const OBSERVATION_VALUE_DECIMALS = 8;

export interface OnchainVerificationResult {
  key: string;
  label: string;
  poolAddress: string;
  tvlUsd: number;
  blockNumber: number;
  verifiedAt: Date;
  chainSlug: string;
  chainName: string;
  explorerUrl: string | null;
}

export async function getVerificationsForProtocol(
  protocolId: string,
): Promise<OnchainVerificationResult[]> {
  const rows = await db
    .select({
      key: onchainVerifications.key,
      label: onchainVerifications.label,
      poolAddress: onchainVerifications.poolAddress,
      tvlUsd: onchainVerifications.tvlUsd,
      blockNumber: onchainVerifications.blockNumber,
      verifiedAt: onchainVerifications.verifiedAt,
      chainSlug: chains.slug,
      chainName: chains.name,
      explorerUrl: chains.explorerUrl,
    })
    .from(onchainVerifications)
    .innerJoin(chains, eq(chains.id, onchainVerifications.chainId))
    .where(eq(onchainVerifications.protocolId, protocolId));

  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    poolAddress: r.poolAddress,
    tvlUsd: Number(r.tvlUsd),
    blockNumber: Number(r.blockNumber),
    verifiedAt: r.verifiedAt,
    chainSlug: r.chainSlug,
    chainName: r.chainName,
    explorerUrl: r.explorerUrl,
  }));
}

interface PoolOutcome {
  key: string;
  ok: boolean;
  error?: string;
  tvlUsd?: number;
  blockNumber?: bigint;
  // Both only ever set together with a successful `tvlUsd` - see
  // verifyPoolsOnChain, where they're derived from the exact same
  // balances/block read that produced the TVL figure, never fabricated
  // after the fact.
  blockHash?: string;
  calculationInputs?: HistoricalObservationCalculationInput[];
}

export interface PoolTvlToken {
  symbol: string;
  decimals: number;
  coingeckoId: string;
}

export type PoolTvlComputationResult = { ok: true; tvlUsd: number } | { ok: false; error: string };

// Generous fixed-point scale for every intermediate step below - large
// enough that a low-price, high-decimals token (e.g. $0.0000000001/unit)
// doesn't underflow to zero when converted to a scaled integer, while
// BigInt itself has no practical size limit to worry about.
const CALCULATION_SCALE = 30;
const SCALE_FACTOR = BigInt(10) ** BigInt(CALCULATION_SCALE);

// Pure - the actual "raw balance + decimals + USD price -> pool TVL" math,
// split out from verifyPoolsOnChain so it's directly unit-testable with
// plain numbers, no RPC/multicall involved. `balances[i] === null` means
// that token's on-chain read failed - never treated as a zero balance.
// Missing price and missing decimals both surface as an explicit failure
// (never silently 0/skipped/assumed), matching this app's "never fabricate
// a missing value" rule everywhere else.
//
// Every step here uses exact BigInt/fixed-point arithmetic, not JS's
// native floating-point Number. A naive `Number(balance) / 10 **
// decimals` (the previous implementation) silently loses precision for
// ANY balance beyond Number.MAX_SAFE_INTEGER (2^53 ~= 9.007e15) - for an
// 18-decimal token that's just ~0.009 whole tokens, i.e. the *ordinary*
// case for a real pool holding real money, not a rare edge case. `price`
// (an external CoinGecko float) is the one input this function can't make
// more precise than it already is - converted to fixed-point via its own
// decimal-string representation (toFixed, never a floating-point
// multiplication) so multiplying it against the exact balance doesn't
// throw away *more* precision than the price input already carried. The
// result only becomes a plain `number` once, at the very end, for
// storage/display - see this function's test file for the deterministic
// worked example, the large-balance precision test, and why the old
// implementation would have failed it.
export function computePoolTvl(
  tokens: PoolTvlToken[],
  balances: (bigint | null)[],
  priceById: Map<string, number>,
): PoolTvlComputationResult {
  let tvlScaled = BigInt(0);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const balance = balances[i];
    if (balance == null) return { ok: false, error: `balance read failed for ${token.symbol}` };

    const price = priceById.get(token.coingeckoId);
    if (price == null) return { ok: false, error: `missing USD price for ${token.symbol}` };
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: `invalid USD price for ${token.symbol}: ${price}` };
    }

    // Raw on-chain integer (token.decimals precision) -> exact fixed-point
    // at CALCULATION_SCALE. Pure integer rescaling - no remainder
    // discarded, since CALCULATION_SCALE (30) comfortably exceeds every
    // real ERC-20's decimals (18 is the practical maximum this app
    // tracks); the division branch only exists for a token whose
    // confirmed decimals somehow exceeds that.
    const balanceAtScale =
      CALCULATION_SCALE >= token.decimals
        ? balance * BigInt(10) ** BigInt(CALCULATION_SCALE - token.decimals)
        : balance / BigInt(10) ** BigInt(token.decimals - CALCULATION_SCALE);

    // price -> exact fixed-point via its own decimal-string
    // representation. toFixed (unlike Number.prototype.toString, which
    // switches to exponential notation below ~1e-6) always produces a
    // plain decimal string; parseUnits then parses and rounds it using
    // exact integer arithmetic (confirmed by reading viem's own
    // implementation - it carries digits through string manipulation,
    // never a floating-point multiplication).
    const priceAtScale = parseUnits(price.toFixed(CALCULATION_SCALE), CALCULATION_SCALE);

    // Both operands are exact integers at CALCULATION_SCALE; their product
    // lands at 2xCALCULATION_SCALE, so dividing back down by SCALE_FACTOR
    // undoes an exact prior multiplication rather than discarding
    // meaningful precision.
    const usdValueAtScale = (balanceAtScale * priceAtScale) / SCALE_FACTOR;
    tvlScaled += usdValueAtScale;
  }

  // Final boundary: the one place this function's result becomes a plain
  // JS number - formatUnits' exact string division (not Number(bigint))
  // followed by a single Number() parse of that already-correct decimal
  // string. Storage/display both need a plain number/numeric-string
  // eventually; this is where that conversion happens, not any earlier.
  const tvlUsd = Number(formatUnits(tvlScaled, CALCULATION_SCALE));
  return { ok: true, tvlUsd };
}

/**
 * Verifies every pool on a single chain in one batched round-trip: one
 * multicall covering every pool-token balanceOf read on this chain, plus one
 * getBlockNumber. Mirrors the batching pattern already verified working for
 * the wallet balances route (app/api/wallet/balances/route.ts).
 */
async function verifyPoolsOnChain(
  chainSlug: string,
  pools: VerifiedPool[],
  priceById: Map<string, number>,
): Promise<PoolOutcome[]> {
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) {
    return pools.map((p) => ({
      key: p.key,
      ok: false,
      error: `no RPC configured for chain "${chainSlug}"`,
    }));
  }

  const calls = pools.flatMap((pool) =>
    pool.tokens.map((token) => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [pool.poolAddress as Address],
    })),
  );

  // Fetched first and passed explicitly to multicall's `blockNumber` option
  // (confirmed supported - viem's multicall/readContract params both derive
  // from CallParameters, which includes it) rather than fetching the block
  // number and the balances concurrently: two independent JSON-RPC calls
  // racing each other can land on different blocks if one is mined in
  // between, which would make the stored blockNumber not actually
  // correspond to the state that produced tvlUsd - the whole point of
  // persisting it. Pinning both to one explicit height keeps them
  // consistent, at the cost of one extra sequential round trip.
  //
  // Pinned to a confirmation-adjusted height, not the raw head - the head
  // isn't final, and a reorg would orphan it, leaving the persisted
  // blockNumber referencing a height whose state never became canonical
  // (so the figure couldn't be reproduced by querying it again).
  //
  // Destructured inline (rather than pre-declared with an explicit type)
  // so viem's multicall return type is inferred from this exact call's
  // `contracts` argument - annotating the variable ahead of time via
  // `Awaited<ReturnType<typeof client.multicall>>` resolves the generic
  // with no argument context and collapses each result to `{}`.
  //
  // All three calls run inside one withResilientClient invocation so a
  // retry/failover restarts them together against the same provider - the
  // block number, its hash, and the multicall it pins must always come
  // from the same chain read, never mixed across separately-retried calls
  // against potentially different providers. getBlock and multicall both
  // target the already-pinned blockNumber (not the moving head), so
  // running them concurrently doesn't reintroduce the race the sequential
  // getBlockNumber() read above is guarding against.
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
    return pools.map((p) => ({ key: p.key, ok: false, error: `chain read failed: ${chainRead.chainReadError}` }));
  }
  const [multicallResults, blockNumber, blockHash] = chainRead;

  const outcomes: PoolOutcome[] = [];
  let offset = 0;
  for (const pool of pools) {
    const slice = multicallResults.slice(offset, offset + pool.tokens.length);
    offset += pool.tokens.length;

    // A failed per-token multicall result becomes `null`, never a
    // substituted/assumed balance - computePoolTvl treats that as a hard
    // failure for the whole pool, same as before this was extracted.
    const balances = pool.tokens.map((_, i) => (slice[i]?.status === "success" ? (slice[i].result as bigint) : null));
    const result = computePoolTvl(pool.tokens, balances, priceById);

    if (!result.ok) {
      outcomes.push({ key: pool.key, ok: false, error: result.error });
      continue;
    }

    // The exact per-token snapshot that produced `result.tvlUsd` - every
    // balance here is non-null and every price is defined, or
    // computePoolTvl would have already returned ok:false above.
    const calculationInputs: HistoricalObservationCalculationInput[] = pool.tokens.map((token, i) => ({
      symbol: token.symbol,
      coingeckoId: token.coingeckoId,
      decimals: token.decimals,
      balanceRaw: balances[i]!.toString(),
      priceUsd: priceById.get(token.coingeckoId)!,
    }));

    outcomes.push({ key: pool.key, ok: true, tvlUsd: result.tvlUsd, blockNumber, blockHash, calculationInputs });
  }

  return outcomes;
}

export async function verifyAllPools(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  if (VERIFIED_POOLS.length === 0) return [];

  // Keeps the canonical pools/pool_tokens rows in sync with this file's
  // config before recording any observation against them - the historical
  // insert below needs a real pools.id to reference.
  const poolIdByConfigKey = await syncPoolsFromConfig();

  const [protocolRows, chainRows] = await Promise.all([
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
  ]);
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const uniqueCoingeckoIds = [...new Set(VERIFIED_POOLS.flatMap((p) => p.tokens.map((t) => t.coingeckoId)))];
  let priceById: Map<string, number>;
  // Captured the moment the prices actually come back, not before the call
  // - this is when the snapshot baked into every observation this run
  // produces was genuinely retrieved.
  let priceRetrievedAt: Date;
  try {
    const prices = await priceProvider.getPrices(uniqueCoingeckoIds);
    priceRetrievedAt = new Date();
    priceById = new Map(prices.map((p) => [p.id, p.priceUsd]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return VERIFIED_POOLS.map((p) => ({ key: p.key, ok: false, error: `price lookup failed: ${message}` }));
  }

  const poolsByChain = new Map<string, VerifiedPool[]>();
  for (const pool of VERIFIED_POOLS) {
    const list = poolsByChain.get(pool.chainSlug) ?? [];
    list.push(pool);
    poolsByChain.set(pool.chainSlug, list);
  }

  const perChainOutcomes = await Promise.all(
    [...poolsByChain.entries()].map(([chainSlug, pools]) => verifyPoolsOnChain(chainSlug, pools, priceById)),
  );
  const outcomeByKey = new Map(perChainOutcomes.flat().map((o) => [o.key, o]));

  // One shared timestamp for this whole run, not a fresh `new Date()` per
  // pool - keeps every observation this run produces at the exact same
  // instant, matching historical_observations' own dedup unique index
  // (entityType, entityId, metric, timestamp) and making "everything from
  // one verification run" a coherent, queryable slice.
  const runTimestamp = new Date();

  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const pool of VERIFIED_POOLS) {
    const outcome = outcomeByKey.get(pool.key);
    if (!outcome || !outcome.ok) {
      results.push({ key: pool.key, ok: false, error: outcome?.error ?? "no result" });
      continue;
    }

    const chainId = chainIdBySlug.get(pool.chainSlug);
    if (!chainId) {
      results.push({ key: pool.key, ok: false, error: `chain "${pool.chainSlug}" not found in DB` });
      continue;
    }

    const protocolId = protocolIdBySlug.get(pool.protocolDefillamaSlug) ?? null;
    // Two independent roundings of the same accurate outcome.tvlUsd, one
    // per table's own precision contract - never share a single rounded
    // string between them. Reusing the 2-decimal value for
    // historical_observations (numeric(32,8)) was the exact bug this
    // guards against: a real sub-cent TVL contribution (e.g. $0.0000005)
    // would floor to "0.00" before ever reaching the higher-precision
    // column, instead of the "0.00000050" it actually is.
    const tvlUsdForVerification = outcome.tvlUsd!.toFixed(VERIFICATION_DISPLAY_DECIMALS);
    const tvlUsdForObservation = outcome.tvlUsd!.toFixed(OBSERVATION_VALUE_DECIMALS);
    const blockNumber = String(outcome.blockNumber!);

    try {
      await db
        .insert(onchainVerifications)
        .values({
          key: pool.key,
          protocolId,
          chainId,
          label: pool.label,
          poolAddress: pool.poolAddress,
          tvlUsd: tvlUsdForVerification,
          blockNumber,
        })
        .onConflictDoUpdate({
          target: onchainVerifications.key,
          set: { protocolId, chainId, tvlUsd: tvlUsdForVerification, blockNumber, verifiedAt: runTimestamp },
        });

      // Durable history, distinct from the upserted latest-value row above
      // - see historical_observations' own schema comment. A missing
      // pools.id (chain not yet synced into `pools` - see
      // syncPoolsFromConfig) means there's nothing to attach this
      // observation to; skip the history write but still report the
      // verification itself as successful, since onchain_verifications
      // (the value the existing UI reads) was written either way.
      const poolId = poolIdByConfigKey.get(pool.key);
      if (poolId) {
        await db
          .insert(historicalObservations)
          .values({
            chainId,
            entityType: "pool",
            entityId: poolId,
            metric: "tvl_usd",
            value: tvlUsdForObservation,
            timestamp: runTimestamp,
            blockNumber,
            blockHash: outcome.blockHash ?? null,
            priceSource: priceProvider.name,
            priceRetrievedAt,
            calculationInputs: outcome.calculationInputs ?? null,
            source: "onchain-verification",
            calculationVersion: TVL_CALCULATION_VERSION,
          })
          .onConflictDoNothing();
      }

      results.push({ key: pool.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: pool.key, ok: false, error: message });
    }
  }

  return results;
}
