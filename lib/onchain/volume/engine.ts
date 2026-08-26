import { type Address, type Log } from "viem";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import type { VolumeCalculationInput } from "@/lib/database/schema";
import { scanFromCursor } from "@/lib/indexing/events";
import { getIndexingState } from "@/lib/indexing/state";
import { getNativeTokenPrice, isNativeTokenPriceFresh, type NativeTokenPrice } from "@/lib/onchain/pricing/queries";
import { roundExactDecimal } from "@/lib/onchain/verify-pool";
import { logger } from "@/lib/observability/logger";
import { aggregateSwapVolume, classifyVolumeConfidence } from "./aggregate";
import { type VolumeSourcePool, type VolumeSourceToken, VOLUME_SOURCE_POOLS } from "./config";
import { readV2ProtocolFeeState, resolveProtocolRevenue } from "./protocol-fee";
import { checkRevenueConsistency, checkVolumeFeeConsistency, checkVolumeSpike } from "./quality";
import { getChainId, getLatestVolumeObservation, getPoolIdByConfigKey } from "./queries";
import { recordSwapEvents, type SwapEventRecord } from "./record-swap-events";
import { recordVolumeObservation } from "./record-volume-observation";
import type { DecodedSwapEvent, SwapVolumeResult } from "./types";
import { computeSwapVolumeUsd, decodeSwapLog, SWAP_EVENT_SIGNATURE, type SwapTokenPrice } from "./uniswap-v2";

// The RPC-touching orchestration layer that ties every other file in this
// module together - not unit-tested directly (this codebase's established
// convention: engine.ts files touch real RPC/DB clients, so only their
// extracted pure decision functions are unit-tested; see
// lib/onchain/pricing/engine.ts's own resolveReferenceAssetOutcome for the
// precedent this mirrors). Exercised instead via
// engine.integration.test.ts (real Postgres, no mocked chain calls beyond
// what withResilientClient itself allows injecting) and, before that, via
// live tsx smoke-testing against the real chain during development.

// Empirically discovered live against this app's own default free-tier RPC
// (ethereum-rpc.publicnode.com via lib/chains/rpc-client.ts's
// DEFAULT_RPC_URLS): eth_getLogs ranges up to ~93-94 blocks succeed and
// anything at or above ~95 fails ("Archive requests require a personal
// token"), REGARDLESS of how close the range sits to the current chain
// head - a genuinely different constraint from lib/indexing/events.ts's
// own DEFAULT_CHUNK_SIZE (2000), which assumes a materially more
// permissive provider. This boundary was re-measured twice during this
// phase's own development and moved between measurements (~100-150 blocks
// the first time, ~93-94 the second, hours later) - a provider-side policy
// that can tighten without notice, not a fixed protocol limit. 50 is
// deliberately well under the tighter of the two observed boundaries, not
// cut precisely to the edge of either one, so a further, similarly-sized
// tightening doesn't silently break indexing again. This is Section 27's
// "adaptive block-range sizing" requirement in its simplest safe form: a
// conservative, explicit override for THIS indexer, rather than changing
// the shared library default (which scan-events-example.ts and any future
// consumer with a more permissive provider still benefit from at its
// original, larger size).
const DEFAULT_VOLUME_CHUNK_SIZE = BigInt(50);

// A SEPARATE, more surprising discovery from the same live testing: this
// provider's free tier does not serve eth_getLogs for ANY block more than
// ~100-110 blocks behind the current chain head AT ALL, no matter how
// small the requested range is - confirmed by testing single-block ranges
// at increasing depth from head (depth <=100 succeeded every time, depth
// >=110 failed identically to a large range). This is a genuinely
// different constraint from DEFAULT_VOLUME_CHUNK_SIZE above (a per-call
// range-size cap): it means a FIXED, config-time startBlock
// (VolumeSourcePool.startBlock) becomes permanently unreachable through
// this provider the moment real time moves the chain head more than ~100
// blocks past it - which happens routinely (roughly every 20 minutes on
// Ethereum), including simply from a branch sitting unrun for a while
// before its first live run (exactly what happened during this phase's own
// development: the configured startBlock, chosen fresh at config-authoring
// time, had already drifted out of this window by the time the worker was
// first actually run). effectiveStartBlock below is the fix: the
// first-ever scan for a pool (no persisted cursor yet) starts from
// whichever is MORE RECENT of the configured startBlock and "currentBlock
// minus this safe window" - never further back than this provider can
// actually serve, regardless of how stale the config value has become.
// Once a real cursor exists, this has no effect at all - scanFromCursor
// only ever consults startBlock on a genuinely first-ever run (see its own
// comment), so a pool that has already begun indexing keeps advancing from
// its own real, already-scanned position exactly as before.
const SAFE_LOOKBACK_BLOCKS = BigInt(80);

function effectiveStartBlock(pool: VolumeSourcePool, currentBlock: bigint): bigint {
  const recentFloor = currentBlock > SAFE_LOOKBACK_BLOCKS ? currentBlock - SAFE_LOOKBACK_BLOCKS : BigInt(0);
  return pool.startBlock > recentFloor ? pool.startBlock : recentFloor;
}

// historical_observations.value is numeric(32,8) - same reasoning and same
// reused roundExactDecimal as price-reference-assets.ts's
// OBSERVATION_VALUE_DECIMALS.
const OBSERVATION_VALUE_DECIMALS = 8;

// Bumped only if this adapter's methodology changes (e.g. a V3 adapter, or
// a different volume convention) - see uniswap-v2.ts's own header comment
// for the input-side-only convention this version number currently
// reflects.
const VOLUME_CALCULATION_VERSION = "uniswap-v2-input-side-only-v1";

export interface PoolVolumeRunResult {
  poolKey: string;
  ok: boolean;
  error?: string;
  swapCount?: number;
  pricedSwapCount?: number;
  unpricedSwapCount?: number;
  volumeUsd?: string;
  feesUsd?: string;
  revenueOutcome?: "verified-zero" | "unavailable";
  qualityFlags?: string[];
}

// Phase 5.3's native price engine is reused exactly as-is (Section 21:
// "never reinvent price discovery per-adapter") - looked up ONCE per run
// per token, not once per swap, and only trusted if still fresh by the
// exact same isNativeTokenPriceFresh bar Phase 5.3's own TVL override
// already relies on (lib/onchain/pricing/tvl-integration.ts). No
// CoinGecko fallback is added here: both this pool's tokens (USDC, WETH)
// are already-configured Phase 5.3 REFERENCE_ASSETS, priced on their own
// independent schedule (workers/onchain/price.ts) - a swap whose tokens
// haven't been priced recently enough is genuinely unpriced for this run
// (contributes to unpricedSwapCount, never a fabricated $0 - Section 22),
// not silently patched over with a second, different pricing source.
function toSwapTokenPrice(token: VolumeSourceToken, native: NativeTokenPrice | null, now: Date): SwapTokenPrice | null {
  if (!native) return null;
  if (!isNativeTokenPriceFresh(native.observedAt, now)) return null;
  return { symbol: token.symbol, decimals: token.decimals, priceUsd: native.priceUsd, priceSource: "onchain-pricing-engine" };
}

interface ProcessSwapLogsParams {
  pool: VolumeSourcePool;
  chainId: string;
  poolId: string;
  logs: Log[];
  token0Price: SwapTokenPrice | null;
  token1Price: SwapTokenPrice | null;
  // The block this run's scan actually resumed from (computed once, before
  // scanFromCursor was called - see indexPoolVolume) - provenance-only,
  // never used for any write decision, so a benign discrepancy with what
  // scanFromCursor internally recomputes can never cause a correctness bug,
  // only a slightly-off display value in calculationInputs.fromBlock.
  scanFromBlockForProvenance: bigint;
}

// The idempotent core of one indexing run - called from inside
// scanFromCursor's onLogs, so it MUST complete (including every DB write)
// before that cursor advances, and safe to re-run with the exact same logs
// if a retry happens (every write here is onConflictDoNothing against a
// deterministic identity - see record-swap-events.ts/
// record-volume-observation.ts). A single malformed log is skipped and
// logged, never fatal to the batch; a thrown error (RPC/DB failure)
// intentionally propagates so scanFromCursor's own error handling leaves
// the cursor un-advanced for a clean retry next run.
async function processSwapLogs(params: ProcessSwapLogsParams): Promise<Omit<PoolVolumeRunResult, "poolKey" | "ok" | "error">> {
  const { pool, chainId, poolId, logs, token0Price, token1Price, scanFromBlockForProvenance } = params;

  const decodedRaw: Omit<DecodedSwapEvent, "blockTimestamp">[] = [];
  let malformedCount = 0;
  for (const log of logs) {
    const decoded = decodeSwapLog(log);
    if (!decoded) {
      malformedCount++;
      continue;
    }
    decodedRaw.push(decoded);
  }
  if (malformedCount > 0) {
    logger.warn("volume indexing: skipped malformed swap log(s)", { component: "onchain-volume", pool: pool.key, malformedCount });
  }

  if (decodedRaw.length === 0) {
    // A genuinely empty window - no aggregate observation is written this
    // run. indexing_state's own advanced cursor already proves this range
    // was scanned, which is what distinguishes "scanned, zero swaps" from
    // "not yet indexed" - a $0 row here would add nothing but noise.
    return { swapCount: 0, pricedSwapCount: 0, unpricedSwapCount: 0 };
  }

  // Timestamps aren't on the log itself - fetched once per UNIQUE block
  // number in this batch (never once per event), sequentially, through the
  // same resilient/failover client every other on-chain read in this app
  // uses.
  const uniqueBlockNumbers = [...new Set(decodedRaw.map((d) => d.blockNumber))];
  const timestampByBlock = new Map<bigint, Date>();
  for (const blockNumber of uniqueBlockNumbers) {
    const block = await withResilientClient(pool.chainSlug, (client) => client.getBlock({ blockNumber }));
    timestampByBlock.set(blockNumber, new Date(Number(block.timestamp) * 1000));
  }

  const decodedEvents: DecodedSwapEvent[] = decodedRaw.map((d) => ({ ...d, blockTimestamp: timestampByBlock.get(d.blockNumber)! }));

  const volumeResults: SwapVolumeResult[] = decodedEvents.map((event) =>
    computeSwapVolumeUsd({ amount0In: event.amount0In, amount1In: event.amount1In, token0: token0Price, token1: token1Price }),
  );

  // Raw truth recorded before any USD math is trusted for the aggregate -
  // if everything after this line throws, the raw events this run
  // observed are still durably recorded (Section 22's "preserve raw
  // amounts" applies at the run level too, not just per-field).
  await recordSwapEvents(decodedEvents.map((event): SwapEventRecord => ({ chainId, poolId, sourceKind: pool.sourceKind, event })));

  const aggregate = aggregateSwapVolume(volumeResults, pool.feeBps);
  const confidence = classifyVolumeConfidence(aggregate.pricedSwapCount, aggregate.unpricedSwapCount);

  // Pinned to the last swap actually observed this run (highest
  // blockNumber, then highest logIndex as the tiebreak within that block) -
  // not the scanned range's technical upper bound. The swap's own
  // log.blockHash (already decoded, zero extra RPC calls) is reused
  // directly as this observation's provenance hash.
  const pinnedEvent = decodedEvents.reduce((a, b) =>
    b.blockNumber > a.blockNumber || (b.blockNumber === a.blockNumber && b.logIndex > a.logIndex) ? b : a,
  );
  const pinnedTimestamp = timestampByBlock.get(pinnedEvent.blockNumber)!;

  const [previousVolume, protocolFeeState] = await Promise.all([
    getLatestVolumeObservation(poolId, "volume_usd"),
    readV2ProtocolFeeState(pool.chainSlug, pool.factoryAddress).catch((err) => {
      logger.warn("volume indexing: protocol fee state read failed - revenue marked unavailable this run", {
        component: "onchain-volume",
        pool: pool.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
  ]);

  const volumeUsd = roundExactDecimal(aggregate.volumeUsd, OBSERVATION_VALUE_DECIMALS);
  const feesUsd = roundExactDecimal(aggregate.feesUsd, OBSERVATION_VALUE_DECIMALS);

  const qualityFlags = [...checkVolumeFeeConsistency(volumeUsd, feesUsd), ...checkVolumeSpike(volumeUsd, previousVolume?.value ?? null)];
  if (qualityFlags.length > 0) {
    logger.warn("volume indexing: quality flags on this run's observation", { component: "onchain-volume", pool: pool.key, qualityFlags });
  }

  const calculationInputs: VolumeCalculationInput = {
    eventType: "Swap",
    sourceContract: pool.poolAddress,
    sourceChainSlug: pool.chainSlug,
    fromBlock: scanFromBlockForProvenance.toString(),
    toBlock: pinnedEvent.blockNumber.toString(),
    swapCount: aggregate.swapCount,
    pricedSwapCount: aggregate.pricedSwapCount,
    unpricedSwapCount: aggregate.unpricedSwapCount,
    token0: {
      symbol: pool.token0.symbol,
      coingeckoId: pool.token0.coingeckoId,
      decimals: pool.token0.decimals,
      priceUsd: token0Price?.priceUsd ?? null,
      priceSource: token0Price ? "onchain-pricing-engine" : null,
    },
    token1: {
      symbol: pool.token1.symbol,
      coingeckoId: pool.token1.coingeckoId,
      decimals: pool.token1.decimals,
      priceUsd: token1Price?.priceUsd ?? null,
      priceSource: token1Price ? "onchain-pricing-engine" : null,
    },
    ...(qualityFlags.length > 0 ? { qualityFlags } : {}),
  };

  await recordVolumeObservation({
    poolId,
    chainId,
    metric: "volume_usd",
    value: volumeUsd,
    blockNumber: pinnedEvent.blockNumber.toString(),
    blockHash: pinnedEvent.blockHash,
    timestamp: pinnedTimestamp,
    calculationInputs,
    calculationVersion: VOLUME_CALCULATION_VERSION,
    confidence,
  });
  await recordVolumeObservation({
    poolId,
    chainId,
    metric: "fees_usd",
    value: feesUsd,
    blockNumber: pinnedEvent.blockNumber.toString(),
    blockHash: pinnedEvent.blockHash,
    timestamp: pinnedTimestamp,
    calculationInputs,
    calculationVersion: VOLUME_CALCULATION_VERSION,
    confidence,
  });

  let revenueOutcome: "verified-zero" | "unavailable" = "unavailable";
  if (protocolFeeState) {
    const revenue = resolveProtocolRevenue(protocolFeeState);
    if (revenue.available) {
      revenueOutcome = "verified-zero";
      const revenueUsd = roundExactDecimal(revenue.revenueUsd, OBSERVATION_VALUE_DECIMALS);
      const revenueFlags = checkRevenueConsistency(revenueUsd);
      await recordVolumeObservation({
        poolId,
        chainId,
        metric: "revenue_usd",
        value: revenueUsd,
        blockNumber: pinnedEvent.blockNumber.toString(),
        blockHash: pinnedEvent.blockHash,
        timestamp: pinnedTimestamp,
        calculationInputs:
          revenueFlags.length > 0 ? { ...calculationInputs, qualityFlags: [...(calculationInputs.qualityFlags ?? []), ...revenueFlags] } : calculationInputs,
        calculationVersion: VOLUME_CALCULATION_VERSION,
        confidence,
      });
    } else {
      logger.info("volume indexing: protocol revenue unavailable this run - not fabricated", {
        component: "onchain-volume",
        pool: pool.key,
        reason: revenue.reason,
      });
    }
  }

  return {
    swapCount: aggregate.swapCount,
    pricedSwapCount: aggregate.pricedSwapCount,
    unpricedSwapCount: aggregate.unpricedSwapCount,
    volumeUsd,
    feesUsd,
    revenueOutcome,
    ...(qualityFlags.length > 0 ? { qualityFlags } : {}),
  };
}

// The top-level entry point for one pool: resolves its canonical DB
// identity, looks up both tokens' native prices once, then scans new Swap
// events since the last checkpoint via the existing, unmodified
// scanFromCursor primitive (lib/indexing/events.ts) - the same
// resumable/idempotent/confirmation-aware foundation
// scan-events-example.ts already proved works end-to-end, just with this
// indexer's own component key, chunk size, and onLogs body.
export async function indexPoolVolume(pool: VolumeSourcePool): Promise<PoolVolumeRunResult> {
  const component = `volume:${pool.sourceKind}:${pool.key}`;

  const [chainId, poolId] = await Promise.all([getChainId(pool.chainSlug), getPoolIdByConfigKey(pool.key)]);
  if (!chainId) return { poolKey: pool.key, ok: false, error: `chain "${pool.chainSlug}" not found in DB` };
  if (!poolId) return { poolKey: pool.key, ok: false, error: `pool "${pool.key}" not yet synced into \`pools\` - run TVL verification first` };

  const now = new Date();
  const [token0Native, token1Native] = await Promise.all([
    getNativeTokenPrice(pool.chainSlug, pool.token0.address),
    getNativeTokenPrice(pool.chainSlug, pool.token1.address),
  ]);
  const token0Price = toSwapTokenPrice(pool.token0, token0Native, now);
  const token1Price = toSwapTokenPrice(pool.token1, token1Native, now);

  let runResult: Omit<PoolVolumeRunResult, "poolKey" | "ok" | "error"> = {};

  try {
    const currentBlock = await withResilientClient(pool.chainSlug, (client) => client.getBlockNumber());
    const startBlockForThisRun = effectiveStartBlock(pool, currentBlock);
    const priorState = await getIndexingState(pool.chainSlug, component);
    const scanFromBlockForProvenance = priorState?.lastProcessedBlock != null ? priorState.lastProcessedBlock + BigInt(1) : startBlockForThisRun;

    await scanFromCursor({
      chainSlug: pool.chainSlug,
      component,
      address: pool.poolAddress as Address,
      eventSignature: SWAP_EVENT_SIGNATURE,
      currentBlock,
      startBlock: startBlockForThisRun,
      chunkSize: DEFAULT_VOLUME_CHUNK_SIZE,
      confirmations: confirmationsFor(pool.chainSlug),
      onLogs: async (logs) => {
        runResult = await processSwapLogs({ pool, chainId, poolId, logs, token0Price, token1Price, scanFromBlockForProvenance });
      },
    });
  } catch (err) {
    return { poolKey: pool.key, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { poolKey: pool.key, ok: true, ...runResult };
}

// Indexes every configured pool, one at a time, each with its own
// try/catch so one pool's failure (a bad RPC read, a DB error) never stops
// the rest (Section 34's "failure isolation" requirement). Sequential
// rather than Promise.all across pools - deliberately bounded concurrency
// (Section 33/27's "never unbounded Promise.all") at today's real pool
// count (1); a future larger VOLUME_SOURCE_POOLS should reach for the same
// bounded-chunk pattern lib/utils/chunk.ts already establishes elsewhere in
// this app rather than parallelizing every pool at once.
export async function indexAllPoolVolume(pools: VolumeSourcePool[] = VOLUME_SOURCE_POOLS): Promise<PoolVolumeRunResult[]> {
  const results: PoolVolumeRunResult[] = [];
  for (const pool of pools) {
    try {
      results.push(await indexPoolVolume(pool));
    } catch (err) {
      results.push({ poolKey: pool.key, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
