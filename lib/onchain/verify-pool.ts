import { eq } from "drizzle-orm";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols, chains, type HistoricalObservationCalculationInput } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { logger } from "@/lib/observability/logger";
import { VERIFIED_POOLS, type VerifiedPool } from "./config";
import { syncPoolsFromConfig } from "./pools";
import { recordVerification } from "./record-verification";
import { resolveNativePriceOverrides, priceSourceForTokens } from "./pricing/tvl-integration";

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
  // An exact decimal string (see computePoolTvl) - never a `number`, so a
  // TVL beyond Number.MAX_SAFE_INTEGER with a real fractional component
  // can't be corrupted before it's ever persisted.
  tvlUsd?: string;
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

// `tvlUsd` is an exact decimal string, never a `number` - see
// computePoolTvl's own comment for why the calculation itself must never
// collapse to floating point, even at its own return boundary. A caller
// that genuinely needs a plain number for display (e.g. a UI-bound field
// capped at 2 decimals, far below Number.MAX_SAFE_INTEGER for any real
// protocol TVL) converts explicitly at its own call site - that's the
// "clearly intentional display boundary," not this function.
export type PoolTvlComputationResult = { ok: true; tvlUsd: string } | { ok: false; error: string };

// Generous fixed-point scale for every intermediate step below - large
// enough that a low-price, high-decimals token (e.g. $0.0000000001/unit)
// doesn't underflow to zero when converted to a scaled integer, while
// BigInt itself has no practical size limit to worry about.
const CALCULATION_SCALE = 30;
const SCALE_FACTOR = BigInt(10) ** BigInt(CALCULATION_SCALE);

// Converts a provider-supplied price (necessarily a JS `number` - that's
// PriceProvider's own interface, outside this function's control) into the
// exact decimal string that number actually holds. This is the ONE place
// in the whole native-TVL pipeline a price is still a `number` - every
// caller converts here, once, before the price ever reaches computePoolTvl
// (see priceById below, now string-keyed) or a persisted calculationInputs
// snapshot. Number.prototype.toString() is preferred over toFixed(): for
// any price that was originally a "clean" decimal (the overwhelmingly
// common case - "1.23", "0.1", "3123.456789"), toString() produces the
// shortest decimal that round-trips to the same double, which for those
// values IS the original clean decimal - toFixed(30) would instead print
// that double's full binary expansion (e.g. "0.100000000000000005551115..."
// for 0.1), preserving noise that was never part of the provider's actual
// price. toString() switches to exponential notation outside roughly
// 1e-7..1e21 though, which parseUnits can't parse - toFixed(CALCULATION_SCALE)
// is the fallback there specifically because it never uses exponential
// notation, not because it's the preferred path.
export function priceToExactDecimalString(price: number): string {
  const shortest = price.toString();
  if (!shortest.includes("e") && !shortest.includes("E")) return shortest;
  return price.toFixed(CALCULATION_SCALE);
}

const EXACT_NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

// Pure - the actual "raw balance + decimals + USD price -> pool TVL" math,
// split out from verifyPoolsOnChain so it's directly unit-testable with
// plain numbers, no RPC/multicall involved. `balances[i] === null` means
// that token's on-chain read failed - never treated as a zero balance.
// Missing price and missing decimals both surface as an explicit failure
// (never silently 0/skipped/assumed), matching this app's "never fabricate
// a missing value" rule everywhere else.
//
// Every step here - balance normalization, price, per-token USD value, and
// the running TVL total - is exact BigInt/fixed-point arithmetic, never
// JS's native floating-point Number, and the function's own return value
// stays an exact decimal string for the same reason (see
// PoolTvlComputationResult above). A naive `Number(balance) / 10 **
// decimals` (an earlier implementation) silently loses precision for ANY
// balance beyond Number.MAX_SAFE_INTEGER (2^53 ~= 9.007e15) - for an
// 18-decimal token that's just ~0.009 whole tokens, i.e. the *ordinary*
// case for a real pool holding real money, not a rare edge case.
// `priceById` is string-keyed rather than Map<string, number> so this
// function never sees a floating-point price at all - the one unavoidable
// number->string conversion (priceToExactDecimalString) happens once, in
// the caller, before prices ever reach here. This is also what makes a
// persisted calculationInputs snapshot genuinely replayable: the exact
// same string that was fed in here is the exact same string stored, with
// no additional round-trip through Number in either direction. See this
// function's test file for the deterministic worked examples, the
// precision regression tests, and why an earlier Number-based
// implementation would have failed them.
export function computePoolTvl(
  tokens: PoolTvlToken[],
  balances: (bigint | null)[],
  priceById: Map<string, string>,
): PoolTvlComputationResult {
  let tvlScaled = BigInt(0);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const balance = balances[i];
    if (balance == null) return { ok: false, error: `balance read failed for ${token.symbol}` };

    const price = priceById.get(token.coingeckoId);
    if (price == null) return { ok: false, error: `missing USD price for ${token.symbol}` };
    if (!EXACT_NON_NEGATIVE_DECIMAL.test(price)) {
      return { ok: false, error: `invalid USD price for ${token.symbol}: ${price}` };
    }

    // A token whose confirmed decimals exceed CALCULATION_SCALE can't be
    // rescaled up to it by multiplication - the only alternative is
    // dividing back down, which discards whatever's below CALCULATION_SCALE
    // and silently truncates the raw balance. CALCULATION_SCALE (30)
    // comfortably exceeds every real ERC-20 this app tracks (18 is the
    // practical maximum), so this is a defensive, not a practical, case -
    // but "practically doesn't happen" isn't "exact," and this function's
    // entire contract is exact arithmetic or an explicit failure, never a
    // silent precision loss. Rejecting outright (rather than adding
    // arbitrary-precision support for a case with no known real-world
    // instance) keeps that contract simple and honest.
    if (token.decimals > CALCULATION_SCALE) {
      return {
        ok: false,
        error: `unsupported decimals for ${token.symbol}: ${token.decimals} exceeds this calculation's ${CALCULATION_SCALE}-decimal scale`,
      };
    }

    // Raw on-chain integer (token.decimals precision) -> exact fixed-point
    // at CALCULATION_SCALE. Pure integer rescaling - no remainder
    // discarded; the check above guarantees the exponent here is never
    // negative.
    const balanceAtScale = balance * BigInt(10) ** BigInt(CALCULATION_SCALE - token.decimals);

    // price is already an exact decimal string (see priceById above) -
    // parseUnits parses and rounds it using exact integer arithmetic
    // (confirmed by reading viem's own implementation - it carries digits
    // through string manipulation, never a floating-point multiplication).
    const priceAtScale = parseUnits(price, CALCULATION_SCALE);

    // Both operands are exact integers at CALCULATION_SCALE; their product
    // lands at 2xCALCULATION_SCALE, so dividing back down by SCALE_FACTOR
    // undoes an exact prior multiplication rather than discarding
    // meaningful precision.
    const usdValueAtScale = (balanceAtScale * priceAtScale) / SCALE_FACTOR;
    tvlScaled += usdValueAtScale;
  }

  // The exact decimal string, straight from formatUnits' string-based
  // division - deliberately NOT wrapped in Number() here. That final
  // collapse to floating point is exactly what an earlier review round
  // flagged: a `number` can't hold a value beyond Number.MAX_SAFE_INTEGER
  // (~9e15) with a real fractional part at the same time, and a pool TVL
  // is not guaranteed to stay under that ceiling forever. Callers that
  // only need a bounded-precision display value (e.g. a 2-decimal UI
  // field) convert explicitly at their own call site - see
  // roundExactDecimal below.
  const tvlUsd = formatUnits(tvlScaled, CALCULATION_SCALE);
  return { ok: true, tvlUsd };
}

// Rescales an exact decimal string (as produced by computePoolTvl, at
// CALCULATION_SCALE) down to fewer decimal places, entirely through BigInt
// arithmetic - never Number()/toFixed(), which round a *floating-point*
// approximation of the value rather than the value's own exact digits, and
// silently corrupt anything beyond Number.MAX_SAFE_INTEGER long before a
// real pool's TVL would reach it. Round-half-up; TVL is never negative
// (computePoolTvl rejects negative prices), so signed rounding isn't needed.
export function roundExactDecimal(value: string, decimals: number): string {
  const scaled = parseUnits(value, CALCULATION_SCALE);
  const divisor = BigInt(10) ** BigInt(CALCULATION_SCALE - decimals);
  const rounded = (scaled + divisor / BigInt(2)) / divisor;
  return formatUnits(rounded, decimals);
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
  priceById: Map<string, string>,
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
    // computePoolTvl would have already returned ok:false above. priceUsd
    // is the identical exact string computePoolTvl itself consumed (no
    // separate conversion here), so this snapshot is byte-for-byte what
    // was actually fed into the calculation, not a re-derived copy.
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

export interface PoolVerificationRecord {
  poolKey: string;
  protocolId: string | null;
  chainId: string;
  label: string;
  poolAddress: string;
  tvlUsdForVerification: string;
  blockNumber: string;
  runTimestamp: Date;
  // null means "chain not yet synced into `pools`" - skip the history
  // write, matching verifyAllPools' pre-existing behavior for that case.
  poolId: string | null;
  tvlUsdForObservation: string;
  blockHash: string | null;
  priceSource: string;
  priceRetrievedAt: Date;
  calculationInputs: HistoricalObservationCalculationInput[] | null;
  calculationVersion: string;
}

// The atomic write at the heart of recording one pool's verification: the
// upserted "latest value" (onchain_verifications) and the durable history
// row (historical_observations) commit together, in one transaction, or
// neither does. The actual transaction logic lives in recordVerification
// (record-verification.ts) - shared with recordVaultVerification
// (verify-vault.ts), since the two were byte-for-byte identical except for
// which config/table each pulled its own identifiers from. This wrapper's
// job is entity-specific: translate PoolVerificationRecord's field names
// into the shared record shape (poolKey passed through unchanged as the
// onchain_verifications key - pools are never namespaced, preserving
// exactly what Phase 4/5.1 already wrote, unlike vault keys - see
// record-verification.ts's own comment), and own this entity type's
// logging.
//
// The history write requires BOTH a poolId and a genuinely valid blockHash
// (VALID_BLOCK_HASH - a real 32-byte hex hash, never null, never empty,
// never a malformed/truncated string). A pool TVL observation without a
// real block hash isn't reliable provenance (it can't be checked against a
// reorg later - see lib/onchain/reorg.ts), so recordVerification refuses
// to create one rather than persisting incomplete/fabricated provenance.
// onchain_verifications (the "latest value" the UI reads) still commits
// either way - a missing hash doesn't make the latest TVL figure itself
// untrustworthy, only the durable history record of it. A skip is logged
// here (logger.warn, component: "onchain") specifically so it's an
// observable event, not a silent one. There's no separate "retry the same
// block" path: the next scheduled verification run, on whatever block is
// current then, is the retry.
export async function recordPoolVerification(record: PoolVerificationRecord): Promise<void> {
  const outcome = await recordVerification({
    entityType: "pool",
    verificationKey: record.poolKey,
    protocolId: record.protocolId,
    chainId: record.chainId,
    label: record.label,
    contractAddress: record.poolAddress,
    tvlUsdForVerification: record.tvlUsdForVerification,
    blockNumber: record.blockNumber,
    runTimestamp: record.runTimestamp,
    entityId: record.poolId,
    tvlUsdForObservation: record.tvlUsdForObservation,
    blockHash: record.blockHash,
    priceSource: record.priceSource,
    priceRetrievedAt: record.priceRetrievedAt,
    calculationInputs: record.calculationInputs,
    calculationVersion: record.calculationVersion,
  });

  if (outcome === "skipped-invalid-hash") {
    // This should be rare (verifyPoolsOnChain fetches the hash from the
    // same chain read it already needed for the pinned block number - see
    // its own comment) - a warning here is a real signal something's off
    // with that read or its RPC response, not routine/expected noise.
    logger.warn("skipping native pool TVL historical observation - block hash unavailable or invalid", {
      component: "onchain",
      poolKey: record.poolKey,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
    });
  }
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
  let priceById: Map<string, string>;
  // Captured the moment the prices actually come back, not before the call
  // - this is when the snapshot baked into every observation this run
  // produces was genuinely retrieved.
  let priceRetrievedAt: Date;
  try {
    const prices = await priceProvider.getPrices(uniqueCoingeckoIds);
    priceRetrievedAt = new Date();
    // The provider's price is necessarily a JS `number` (PriceProvider's
    // own interface) - converted to an exact decimal string exactly once,
    // right here, before it's ever passed to computePoolTvl or persisted.
    // Nothing downstream of this line touches a floating-point price.
    priceById = new Map(prices.map((p) => [p.id, priceToExactDecimalString(p.priceUsd)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return VERIFIED_POOLS.map((p) => ({ key: p.key, ok: false, error: `price lookup failed: ${message}` }));
  }

  // Phase 5.3's controlled TVL source-selection policy: for any of these
  // pools' tokens that this app's own on-chain reference-asset pricing
  // engine (lib/onchain/pricing/) has independently priced with sufficient
  // confidence, prefer that price over CoinGecko's - see
  // resolveNativePriceOverrides' own comment for the exact confidence bar.
  // Every existing pool keeps working via CoinGecko unchanged for any token
  // that isn't a configured reference asset, or whose native price isn't
  // confident enough yet. Wrapped in its own try/catch, deliberately never
  // allowed to fail this function: a native-pricing lookup problem must
  // degrade to the CoinGecko price this pipeline already trusted before
  // Phase 5.3 existed, never abort a verification run that would otherwise
  // have succeeded.
  const nativelyPricedCoingeckoIds = new Set<string>();
  try {
    const overrides = await resolveNativePriceOverrides(uniqueCoingeckoIds);
    for (const [coingeckoId, priceUsd] of overrides) {
      priceById.set(coingeckoId, priceUsd);
      nativelyPricedCoingeckoIds.add(coingeckoId);
    }
  } catch (err) {
    logger.warn("native reference-asset price lookup failed - falling back to CoinGecko pricing for this run", {
      component: "onchain",
      error: err instanceof Error ? err.message : String(err),
    });
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
    const tvlUsdForVerification = roundExactDecimal(outcome.tvlUsd!, VERIFICATION_DISPLAY_DECIMALS);
    const tvlUsdForObservation = roundExactDecimal(outcome.tvlUsd!, OBSERVATION_VALUE_DECIMALS);
    const blockNumber = String(outcome.blockNumber!);

    try {
      await recordPoolVerification({
        poolKey: pool.key,
        protocolId,
        chainId,
        label: pool.label,
        poolAddress: pool.poolAddress,
        tvlUsdForVerification,
        blockNumber,
        runTimestamp,
        // A missing pools.id (chain not yet synced into `pools` - see
        // syncPoolsFromConfig) means there's nothing to attach a history
        // observation to; recordPoolVerification skips that write but
        // still commits the verification itself, since onchain_verifications
        // (the value the existing UI reads) is the only row that can exist
        // for this pool in that case.
        poolId: poolIdByConfigKey.get(pool.key) ?? null,
        tvlUsdForObservation,
        blockHash: outcome.blockHash ?? null,
        // "onchain-pricing-engine" if every one of this pool's tokens used
        // a native reference-asset price this run, a "hybrid:..." tag if
        // only some did, or priceProvider.name unchanged if none did - see
        // priceSourceForTokens' own comment for why a genuine mix must
        // never be mislabeled as either pure kind.
        priceSource: priceSourceForTokens(pool.tokens.map((t) => t.coingeckoId), nativelyPricedCoingeckoIds, priceProvider.name),
        priceRetrievedAt,
        calculationInputs: outcome.calculationInputs ?? null,
        calculationVersion: TVL_CALCULATION_VERSION,
      });

      results.push({ key: pool.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: pool.key, ok: false, error: message });
    }
  }

  return results;
}
