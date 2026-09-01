import { type Address, type Log } from "viem";
import { confirmationsFor, safeHeadFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import type { VolumeCalculationInput } from "@/lib/database/schema";
import { scanFromCursor, type ScanChunk } from "@/lib/indexing/events";
import { selectRotatingBatch } from "@/lib/indexing/rotation";
import { getIndexingState, updateIndexingState } from "@/lib/indexing/state";
import { getNativeTokenPrice, type NativeTokenPrice } from "@/lib/onchain/pricing/queries";
import { isNativePriceEligibleForTvl } from "@/lib/onchain/pricing/tvl-integration";
import { roundExactDecimal } from "@/lib/onchain/verify-pool";
import { logger } from "@/lib/observability/logger";
import { aggregateSwapVolume, classifyVolumeConfidence } from "./aggregate";
import { type VolumeSourcePool, type VolumeSourceToken, VOLUME_SOURCE_POOLS } from "./config";
import { computeSwapVolumeUsd, type SwapTokenPrice } from "./math";
import { readV2ProtocolFeeStateAcrossRange, resolveProtocolRevenueForRange, resolveV3ProtocolRevenueForRange, type ProtocolRevenueOutcome } from "./protocol-fee";
import { checkRevenueConsistency, checkVolumeFeeConsistency, checkVolumeSpike } from "./quality";
import { getChainId, getLatestVolumeObservation, getPoolIdByConfigKey } from "./queries";
import { recordSwapEvents, type SwapEventRecord } from "./record-swap-events";
import { recordVolumeObservation, type VolumeObservationWriteOutcome } from "./record-volume-observation";
import type { DecodedSwapEvent, SwapVolumeResult } from "./types";
import { decodeSwapLog, SWAP_EVENT_SIGNATURE } from "./uniswap-v2";
import { decodeV3SwapLog, V3_SWAP_EVENT_SIGNATURE } from "./uniswap-v3";

// Per-sourceKind dispatch (Section "protocol adapter architecture" - common
// primitives in math.ts/record-swap-events.ts/protocol-fee.ts's own shared
// ProtocolRevenueOutcome shape, thin protocol-specific adapters in
// uniswap-v2.ts/uniswap-v3.ts). Deliberately three small, explicit
// functions rather than one generic "adapter interface" object per pool -
// with exactly two protocols, an interface layer would hide more than it
// would clarify; a switch that fails to compile if a third sourceKind is
// ever added without a matching arm here is the more honest tool for this
// job's actual size.
function swapEventSignatureFor(pool: VolumeSourcePool): string {
  return pool.sourceKind === "uniswap-v3" ? V3_SWAP_EVENT_SIGNATURE : SWAP_EVENT_SIGNATURE;
}

function decodeSwapLogFor(pool: VolumeSourcePool, log: Log): Omit<DecodedSwapEvent, "blockTimestamp"> | null {
  return pool.sourceKind === "uniswap-v3" ? decodeV3SwapLog(log) : decodeSwapLog(log);
}

// V2's methodology version and V3's are versioned INDEPENDENTLY, even
// though both currently implement the identical input-side-only
// convention (math.ts) - a future change to only one protocol's own
// decode/fee logic should only bump that protocol's own version string,
// never force every existing V2 row to look like it used a "new" version
// it never actually used.
function calculationVersionFor(pool: VolumeSourcePool): string {
  return pool.sourceKind === "uniswap-v3" ? "uniswap-v3-input-side-only-v1" : "uniswap-v2-input-side-only-v1";
}

// Reads and resolves this pool's protocol-revenue state for the given
// range, dispatching to the correct protocol's own read (V2:
// factory.feeTo(), boundary-pinned only - see protocol-fee.ts's own module
// comment for that mechanism's own scope; V3: pool.slot0().feeProtocol,
// reconstructed from real SetFeeProtocol transition events across the
// whole range, not just its two boundaries - see protocol-fee.ts's
// "Historical-transition bug fix" section for why the boundary-only check
// was insufficient for V3 and what replaced it). Never throws - an RPC
// failure here degrades to "no revenue outcome this chunk" (logged), the
// same resilience the V2-only version of this code already had.
async function resolveProtocolRevenueForPool(pool: VolumeSourcePool, fromBlock: bigint, toBlock: bigint): Promise<ProtocolRevenueOutcome | null> {
  try {
    if (pool.sourceKind === "uniswap-v3") {
      return await resolveV3ProtocolRevenueForRange(pool.chainSlug, pool.poolAddress, fromBlock, toBlock);
    }
    if (!pool.factoryAddress) {
      throw new Error(`pool "${pool.key}" is sourceKind "uniswap-v2" but has no configured factoryAddress`);
    }
    const check = await readV2ProtocolFeeStateAcrossRange(pool.chainSlug, pool.factoryAddress, fromBlock, toBlock);
    return resolveProtocolRevenueForRange(check);
  } catch (err) {
    logger.warn("volume indexing: protocol fee state read failed - revenue marked unavailable this run", {
      component: "onchain-volume",
      pool: pool.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

export interface EffectiveStartBlockResult {
  startBlock: bigint;
  // > 0 whenever the configured pool.startBlock had to be raised to stay
  // within the provider's live-servable window - i.e. blocks between the
  // configured start and the actual effective start are never scanned at
  // all for this pool's first-ever run. Exposed (not just used internally)
  // so the caller can log this loudly rather than silently proceeding as
  // if the configured value were honored - a real, intentional gap in
  // coverage, not a bug, but one that must never be invisible.
  skippedBlocks: bigint;
}

// CodeRabbit fix round: the lookback window must be measured from the
// CONFIRMED head, not the raw current head - scanFromCursor itself never
// scans up to the raw head either (it subtracts confirmationsFor(chainSlug)
// to compute its own safeToBlock - see lib/indexing/events.ts). Anchoring
// effectiveStartBlock to the raw head instead would shift its 80-block
// window `confirmations` blocks higher than the range scanFromCursor can
// actually reach, silently narrowing the effective lookback for chains
// with deeper confirmation requirements (e.g. Polygon's 128) without ever
// being wrong in a way that surfaces as an error - just a smaller-than-
// intended safety margin. Phase 5.5: both this function and
// scanFromCursor now derive their safe head from the SAME
// lib/chains/confirmations.ts's safeHeadFor - previously each carried an
// independent, textually-identical copy of the same formula, exactly the
// "multiple competing safe-head calculations" Phase 5.5 forbids. Pure and
// directly testable with a plain currentBlock input, no RPC call of its
// own.
//
// Deliberately typed against a minimal structural shape ({chainSlug,
// startBlock}) rather than the full VolumeSourcePool - both this module's
// own pools AND lib/onchain/discovery/config.ts's FactoryDeployment share
// exactly these two fields for exactly the same reason (a configured
// floor that can go stale relative to a free RPC provider's narrow
// live-servable window), so discovery's own first-ever scan reuses this
// exact function rather than carrying a second, textually-identical copy
// of the same safe-window formula - the same "one safe-head calculation,
// not several" discipline this function's own header comment already
// establishes for safeHeadFor itself.
export function effectiveStartBlock(pool: { chainSlug: string; startBlock: bigint }, currentBlock: bigint): EffectiveStartBlockResult {
  const safeHead = safeHeadFor(pool.chainSlug, currentBlock);
  const recentFloor = safeHead > SAFE_LOOKBACK_BLOCKS ? safeHead - SAFE_LOOKBACK_BLOCKS : BigInt(0);
  const startBlock = pool.startBlock > recentFloor ? pool.startBlock : recentFloor;
  const skippedBlocks = startBlock > pool.startBlock ? startBlock - pool.startBlock : BigInt(0);
  return { startBlock, skippedBlocks };
}

// historical_observations.value is numeric(32,8) - same reasoning and same
// reused roundExactDecimal as price-reference-assets.ts's
// OBSERVATION_VALUE_DECIMALS.
const OBSERVATION_VALUE_DECIMALS = 8;

// One chunk's own result - Phase 5.5's scanFromCursor now calls onLogs
// once per chunk (see lib/indexing/events.ts's own module comment), so a
// single indexPoolVolume run can legitimately span many of these when
// catching up a large gap. Each chunk gets its own aggregate
// historicalObservations row (see recordVolumeObservation calls below,
// pinned to THIS chunk's own last-swap block/hash) - never combined across
// chunks into one artificially-wide observation, which would blur exactly
// which block range a given volume/fee/revenue figure actually covers.
export interface ChunkVolumeResult {
  fromBlock: string;
  toBlock: string;
  swapCount: number;
  pricedSwapCount: number;
  unpricedSwapCount: number;
  volumeUsd?: string;
  feesUsd?: string;
  revenueOutcome?: "verified-zero" | "unavailable";
  qualityFlags?: string[];
  // Populated only when a recordVolumeObservation call returned
  // "skipped-invalid-hash" for this chunk - see logIfNotPersisted below.
  unpersistedMetrics?: string[];
}

export interface PoolVolumeRunResult {
  poolKey: string;
  ok: boolean;
  error?: string;
  // Section 26's three-way run outcome. "success": every safe chunk this
  // run needed to process completed. "partial": real, checkpointed
  // progress happened (chunks.length > 0) but the run stopped before
  // reaching the safe head (a provider range limit at the minimum chunk
  // size, or the attempt budget was exhausted) - the cursor is still
  // exactly where the last successful chunk left it, safe to resume next
  // run. "failed": ok is false - either no chunk succeeded at all, or an
  // error occurred before scanning could even start (chain/pool not
  // synced, RPC unreachable for the very first call).
  outcome: "success" | "partial" | "failed";
  chunks: ChunkVolumeResult[];
  chunksCompleted: number;
  chunksAttempted: number;
  // Set only when outcome is "partial" - see ScanResult.stoppedReason
  // (lib/indexing/events.ts) for the exact machine-readable values.
  stoppedReason?: string;
  // Section 24/25's progress fields - computed AFTER this run's scan
  // completes (or stops), so they reflect this run's own real, final
  // position, never an optimistic pre-run estimate. `lag` is safeHead
  // minus the cursor's block number AFTER this run - 0 once fully caught
  // up, a real positive number while still catching up (never silently
  // hidden by reporting "success" for a run that left lag > 0).
  safeHead?: string;
  cursorAfterRun?: string;
  lag?: string;
}

// Phase 5.3's native price engine is reused exactly as-is (Section 21:
// "never reinvent price discovery per-adapter") - looked up ONCE per run
// per token, not once per swap, and only trusted if it clears the exact
// same isNativePriceEligibleForTvl bar Phase 5.3's own TVL override relies
// on (lib/onchain/pricing/tvl-integration.ts) - CONFIDENCE (HIGH/MEDIUM
// only) AND freshness, not freshness alone. No CoinGecko fallback is added
// here: both this pool's tokens (USDC, WETH) are already-configured Phase
// 5.3 REFERENCE_ASSETS, priced on their own independent schedule
// (workers/onchain/price.ts) - a swap whose tokens haven't been priced
// recently/confidently enough is genuinely unpriced for this run
// (contributes to unpricedSwapCount, never a fabricated $0 - Section 22),
// not silently patched over with a second, different pricing source.
//
// Phase 5.8 fix: this used to check freshness only (isNativeTokenPriceFresh
// directly), never native.confidence - a LOW-confidence reference-asset
// price (a single, thinly-liquid source that barely cleared the minimum
// liquidity floor but never reached the comfortable-confidence threshold)
// could still price every swap in a run, and classifyVolumeConfidence
// (aggregate.ts) then labels the resulting volume_usd/fees_usd observation
// "HIGH" whenever every swap got priced - laundering a shaky underlying
// price into an observation that LOOKS fully trustworthy. This is the same
// bar TVL already enforces via isNativePriceEligibleForTvl; volume/fees
// pricing must never be a weaker gate than TVL for the identical
// reference-asset price.
export function toSwapTokenPrice(token: VolumeSourceToken, native: NativeTokenPrice | null, now: Date): SwapTokenPrice | null {
  if (!native) return null;
  if (!isNativePriceEligibleForTvl(native.confidence, native.observedAt, now)) return null;
  return { symbol: token.symbol, decimals: token.decimals, priceUsd: native.priceUsd, priceSource: "onchain-pricing-engine" };
}

interface ProcessSwapLogsParams {
  pool: VolumeSourcePool;
  chainId: string;
  poolId: string;
  logs: Log[];
  token0Price: SwapTokenPrice | null;
  token1Price: SwapTokenPrice | null;
  // This CHUNK's own [fromBlock, toBlock] boundaries (Phase 5.5:
  // scanFromCursor now calls onLogs once per chunk, not once for the whole
  // run - see lib/indexing/events.ts's own module comment). Used both for
  // calculationInputs.fromBlock and as the lower boundary of the
  // historical feeTo() range check below - a genuinely different, tighter
  // range than "the whole run" whenever a run spans more than one chunk.
  chunk: ScanChunk;
}

// The idempotent core of one CHUNK's worth of logs - called from inside
// scanFromCursor's onLogs, once per chunk, so it MUST complete (including
// every DB write) before that chunk's cursor advances, and safe to re-run
// with the exact same logs if a retry happens (every write here is
// onConflictDoNothing against a deterministic identity - see
// record-swap-events.ts/record-volume-observation.ts). A single malformed
// log is skipped and logged, never fatal to the batch; a thrown error
// (RPC/DB failure) intentionally propagates so scanFromCursor's own error
// handling leaves the cursor un-advanced past this chunk for a clean retry
// next run.
async function processSwapLogs(params: ProcessSwapLogsParams): Promise<ChunkVolumeResult> {
  const { pool, chainId, poolId, logs, token0Price, token1Price, chunk } = params;

  const decodedRaw: Omit<DecodedSwapEvent, "blockTimestamp">[] = [];
  let malformedCount = 0;
  for (const log of logs) {
    const decoded = decodeSwapLogFor(pool, log);
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
    // A genuinely empty chunk - no aggregate observation is written for
    // it. indexing_state's own advanced cursor already proves this range
    // was scanned, which is what distinguishes "scanned, zero swaps" from
    // "not yet indexed" - a $0 row here would add nothing but noise.
    return { fromBlock: chunk.fromBlock.toString(), toBlock: chunk.toBlock.toString(), swapCount: 0, pricedSwapCount: 0, unpricedSwapCount: 0 };
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

  const [previousVolume, revenueResolution] = await Promise.all([
    getLatestVolumeObservation(poolId, "volume_usd"),
    // Pinned to BOTH boundaries of the CHUNK this call is actually
    // attributing (chunk.fromBlock..pinnedEvent.blockNumber), never an
    // unpinned "current head" read - see protocol-fee.ts's own header
    // comment for exactly why a current-head-only read cannot correctly
    // attribute revenue for a historical range. Dispatches to the correct
    // protocol's own mechanism (V2 vs V3 - see resolveProtocolRevenueForPool's
    // own comment) and never throws.
    resolveProtocolRevenueForPool(pool, chunk.fromBlock, pinnedEvent.blockNumber),
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
    fromBlock: chunk.fromBlock.toString(),
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

  const unpersistedMetrics: string[] = [];
  // recordVolumeObservation's own onConflictDoNothing distinguishes
  // "written" from "duplicate-ignored" (both fine, idempotent-expected
  // outcomes) from "skipped-invalid-hash" (NOT fine - the observation was
  // never persisted at all). Every call's result must be inspected -
  // previously these were fire-and-forget `await`s, so an invalid-hash
  // skip (which should be structurally unreachable given pinnedEvent's
  // hash comes straight from a real decoded on-chain log, but is never
  // assumed impossible) would have vanished with no trace anywhere in this
  // run's own result or logs.
  const volumeOutcome = await recordVolumeObservation({
    poolId,
    chainId,
    metric: "volume_usd",
    value: volumeUsd,
    blockNumber: pinnedEvent.blockNumber.toString(),
    blockHash: pinnedEvent.blockHash,
    timestamp: pinnedTimestamp,
    calculationInputs,
    calculationVersion: calculationVersionFor(pool),
    confidence,
  });
  logIfNotPersisted(volumeOutcome, "volume_usd", pool, pinnedEvent, unpersistedMetrics);

  const feesOutcome = await recordVolumeObservation({
    poolId,
    chainId,
    metric: "fees_usd",
    value: feesUsd,
    blockNumber: pinnedEvent.blockNumber.toString(),
    blockHash: pinnedEvent.blockHash,
    timestamp: pinnedTimestamp,
    calculationInputs,
    calculationVersion: calculationVersionFor(pool),
    confidence,
  });
  logIfNotPersisted(feesOutcome, "fees_usd", pool, pinnedEvent, unpersistedMetrics);

  let revenueOutcome: "verified-zero" | "unavailable" = "unavailable";
  if (revenueResolution) {
    const revenue = revenueResolution;
    if (revenue.available) {
      revenueOutcome = "verified-zero";
      const revenueUsd = roundExactDecimal(revenue.revenueUsd, OBSERVATION_VALUE_DECIMALS);
      const revenueFlags = checkRevenueConsistency(revenueUsd);
      const revenueWriteOutcome = await recordVolumeObservation({
        poolId,
        chainId,
        metric: "revenue_usd",
        value: revenueUsd,
        blockNumber: pinnedEvent.blockNumber.toString(),
        blockHash: pinnedEvent.blockHash,
        timestamp: pinnedTimestamp,
        calculationInputs:
          revenueFlags.length > 0 ? { ...calculationInputs, qualityFlags: [...(calculationInputs.qualityFlags ?? []), ...revenueFlags] } : calculationInputs,
        calculationVersion: calculationVersionFor(pool),
        confidence,
      });
      logIfNotPersisted(revenueWriteOutcome, "revenue_usd", pool, pinnedEvent, unpersistedMetrics);
    } else {
      logger.info("volume indexing: protocol revenue unavailable this run - not fabricated", {
        component: "onchain-volume",
        pool: pool.key,
        reason: revenue.reason,
      });
    }
  }

  return {
    fromBlock: chunk.fromBlock.toString(),
    toBlock: chunk.toBlock.toString(),
    swapCount: aggregate.swapCount,
    pricedSwapCount: aggregate.pricedSwapCount,
    unpricedSwapCount: aggregate.unpricedSwapCount,
    volumeUsd,
    feesUsd,
    revenueOutcome,
    ...(qualityFlags.length > 0 ? { qualityFlags } : {}),
    ...(unpersistedMetrics.length > 0 ? { unpersistedMetrics } : {}),
  };
}

// A write NOT actually persisted (skipped-invalid-hash) must never
// disappear silently - logged as a warning here (never thrown: the
// existing indexing architecture only throws to leave the CURSOR
// un-advanced for a safe retry, and retrying would not change anything for
// a genuinely invalid/missing hash decoded from a real on-chain log - see
// this function's own caller for why cursor-blocking retry is reserved for
// transient RPC/DB failures instead) and surfaced on the run's own result
// via `unpersistedMetrics` so a caller/monitor can see it without reading
// raw logs.
function logIfNotPersisted(
  outcome: VolumeObservationWriteOutcome,
  metric: string,
  pool: VolumeSourcePool,
  pinnedEvent: DecodedSwapEvent,
  unpersistedMetrics: string[],
): void {
  if (outcome !== "skipped-invalid-hash") return;
  unpersistedMetrics.push(metric);
  logger.warn("volume indexing: observation NOT persisted - invalid or missing block hash", {
    component: "onchain-volume",
    pool: pool.key,
    metric,
    blockNumber: pinnedEvent.blockNumber.toString(),
    blockHash: pinnedEvent.blockHash,
  });
}

// The top-level entry point for one pool: resolves its canonical DB
// identity, looks up both tokens' native prices once, then scans new Swap
// events since the last checkpoint via scanFromCursor (lib/indexing/
// events.ts) - the same resumable/idempotent/confirmation-aware foundation
// scan-events-example.ts already proved works end-to-end, just with this
// indexer's own component key, chunk size, and onLogs body. Phase 5.5:
// onLogs is now called once per CHUNK (not once for the whole run), so a
// single call here can legitimately process many chunks while catching up
// a large gap - every chunk's own ChunkVolumeResult is accumulated into
// `chunks` below, never overwritten.
export async function indexPoolVolume(pool: VolumeSourcePool, deadlineAt?: number): Promise<PoolVolumeRunResult> {
  const component = `volume:${pool.sourceKind}:${pool.key}`;

  const [chainId, poolId] = await Promise.all([getChainId(pool.chainSlug), getPoolIdByConfigKey(pool.key)]);
  if (!chainId) return { poolKey: pool.key, ok: false, outcome: "failed", error: `chain "${pool.chainSlug}" not found in DB`, chunks: [], chunksCompleted: 0, chunksAttempted: 0 };
  if (!poolId) {
    return {
      poolKey: pool.key,
      ok: false,
      outcome: "failed",
      error: `pool "${pool.key}" not yet synced into \`pools\` - run TVL verification first`,
      chunks: [],
      chunksCompleted: 0,
      chunksAttempted: 0,
    };
  }

  const now = new Date();
  const [token0Native, token1Native] = await Promise.all([
    getNativeTokenPrice(pool.chainSlug, pool.token0.address),
    getNativeTokenPrice(pool.chainSlug, pool.token1.address),
  ]);
  const token0Price = toSwapTokenPrice(pool.token0, token0Native, now);
  const token1Price = toSwapTokenPrice(pool.token1, token1Native, now);

  const chunks: ChunkVolumeResult[] = [];

  try {
    const currentBlock = await withResilientClient(pool.chainSlug, (client) => client.getBlockNumber());
    const { startBlock: startBlockForThisRun, skippedBlocks } = effectiveStartBlock(pool, currentBlock);
    if (skippedBlocks > BigInt(0)) {
      // Never a silent adjustment - this pool's configured startBlock
      // could not be honored because it now falls outside this RPC
      // provider's live-servable window (see effectiveStartBlock's own
      // comment), so a real range of blocks is intentionally never scanned
      // for this pool's first-ever run.
      logger.warn("volume indexing: configured startBlock is stale relative to the confirmed chain head - skipping ahead to a range this RPC provider can actually serve", {
        component: "onchain-volume",
        pool: pool.key,
        configuredStartBlock: pool.startBlock.toString(),
        effectiveStartBlock: startBlockForThisRun.toString(),
        skippedBlocks: skippedBlocks.toString(),
      });
    }

    const scanResult = await scanFromCursor({
      chainSlug: pool.chainSlug,
      component,
      address: pool.poolAddress as Address,
      eventSignature: swapEventSignatureFor(pool),
      currentBlock,
      startBlock: startBlockForThisRun,
      chunkSize: DEFAULT_VOLUME_CHUNK_SIZE,
      confirmations: confirmationsFor(pool.chainSlug),
      deadlineAt,
      onLogs: async (logs, chunk) => {
        chunks.push(await processSwapLogs({ pool, chainId, poolId, logs, token0Price, token1Price, chunk }));
      },
    });

    const safeHead = safeHeadFor(pool.chainSlug, currentBlock);
    // scanResult.scannedTo is the cursor's position AFTER this run - for
    // the "nothing to do, already caught up" case that value is
    // `fromBlock - 1`, i.e. the cursor unchanged from before this call,
    // which is exactly right for lag reporting too.
    const cursorAfterRun = scanResult.scannedTo;
    const lag = safeHead > cursorAfterRun ? safeHead - cursorAfterRun : BigInt(0);

    if (scanResult.outcome === "partial") {
      // Phase 5.8 fix: this log line used to be emitted BEFORE
      // safeHead/cursorAfterRun/lag were computed, so it omitted exactly
      // the two fields (safeHead, lag) an operator most needs to gauge how
      // far behind this run actually left the pool - moved after that
      // computation, with chain/lag/safeHead added, rather than making a
      // reader cross-reference a separate log line or the run's own
      // eventual result object.
      logger.warn("volume indexing: catch-up run stopped before reaching the safe head - will resume next run", {
        component: "onchain-volume",
        chain: pool.chainSlug,
        pool: pool.key,
        stoppedReason: scanResult.stoppedReason,
        chunksCompleted: scanResult.chunksCompleted,
        chunksAttempted: scanResult.chunksAttempted,
        scannedTo: scanResult.scannedTo.toString(),
        safeHead: safeHead.toString(),
        lag: lag.toString(),
      });
    }

    return {
      poolKey: pool.key,
      ok: true,
      outcome: scanResult.outcome,
      chunks,
      chunksCompleted: scanResult.chunksCompleted,
      chunksAttempted: scanResult.chunksAttempted,
      ...(scanResult.stoppedReason ? { stoppedReason: scanResult.stoppedReason } : {}),
      safeHead: safeHead.toString(),
      cursorAfterRun: cursorAfterRun.toString(),
      lag: lag.toString(),
    };
  } catch (err) {
    // scanFromCursor only throws when either no chunk made it through at
    // all, or a chunk's own onLogs (processSwapLogs) threw - a decode/
    // persistence bug, not a recoverable RPC condition. Either way,
    // whatever chunks DID complete before the throw are still preserved
    // here (and, more importantly, already durably checkpointed in the DB
    // by scanFromCursor itself before it re-threw) - `ok: false` reflects
    // that THIS call did not finish cleanly, not that no progress
    // happened at all.
    return {
      poolKey: pool.key,
      ok: false,
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
      chunks,
      chunksCompleted: chunks.length,
      chunksAttempted: chunks.length,
    };
  }
}

// Indexes every configured pool, one at a time, each with its own
// try/catch so one pool's failure (a bad RPC read, a DB error) never stops
// the rest (Section 34's "failure isolation" requirement). Sequential
// rather than Promise.all across pools - deliberately bounded concurrency
// (Section 33/27's "never unbounded Promise.all") at today's real pool
// count; a future larger VOLUME_SOURCE_POOLS should reach for the same
// bounded-chunk pattern lib/utils/chunk.ts already establishes elsewhere in
// this app rather than parallelizing every pool at once.
//
// Phase 5.8: `app/api/cron/index-volume/route.ts` sets `maxDuration = 60`
// (Vercel's hard execution ceiling for this function) - this is the ONE
// place that real-world constraint is translated into an internal deadline
// (see scanFromCursor's own deadlineAt comment for why maxChunkAttempts
// alone doesn't already cover this). Computed ONCE, here, and shared across
// every pool in this call - not a fresh budget per pool - so a slow first
// pool correctly leaves less time for the next one instead of each pool
// independently assuming it has the whole window to itself. 10s margin
// below the 60s ceiling for connection teardown/final writes/logging after
// the last chunk completes.
const SHARED_RUN_DEADLINE_MS = 50_000;

// Phase 5.10 fix, live-reproduced during this phase's own development: once
// the discovered-pool bridge (Phase 5.9) grew this list from 3 pools to 97,
// a run where the chain head had advanced enough that EVERY pool
// simultaneously needed at least one new chunk of real work exceeded the
// shared deadline above - and because pools were always attempted in the
// SAME fixed order, the SAME ~19-30 pools at the front of the list
// completed every single run while the SAME ~65-75 pools at the tail got
// ZERO chunks processed, run after run, their lag growing without bound
// (confirmed live across two consecutive real runs: the identical pool
// addresses were stuck at zero progress both times). This is the exact
// "one busy entity consumes the whole shared budget forever" failure this
// app's own volume-reorg-recheck job already hit and fixed at a smaller
// scale (CodeRabbit PR #17 - see lib/indexing/rotation.ts's own header for
// the shared fix this reuses). A rotating PRIORITY subset - guaranteed to
// be attempted FIRST, before the shared deadline can be exhausted by
// earlier list members - cycles through the whole pool list across
// successive runs via the same GREATEST()-safe ever-increasing offset
// convention selectRotatingBatch already establishes, persisted under its
// own component key (distinct from volume/reorg.ts's own rotation cursor -
// these are two independent jobs with two independent fairness problems).
// Every pool NOT in this run's priority subset is still attempted
// afterward, in its normal order - this changes nothing for the common
// case (most runs finish comfortably inside the deadline); it only changes
// WHO gets guaranteed processing first when the deadline actually binds.
const PRIORITY_BATCH_SIZE = 10;
const POOL_ROTATION_CHAIN_SLUG = "global"; // not a real chain - rotation isn't scoped to one, mirrors volume/reorg.ts's own convention
const POOL_ROTATION_COMPONENT = "volume-index:pool-rotation";

export interface IndexAllPoolVolumeOptions {
  // Test-only override for the rotation cursor's own (chainSlug,
  // component) indexing_state key - see volume/reorg.ts's own
  // rotationCursorKey for why tests must never touch the real, shared
  // production row (VolumeReorgRecheckOptions.rotationCursorKey's own
  // comment applies identically here).
  rotationCursorKey?: { chainSlug: string; component: string };
}

export async function indexAllPoolVolume(pools: VolumeSourcePool[] = VOLUME_SOURCE_POOLS, options: IndexAllPoolVolumeOptions = {}): Promise<PoolVolumeRunResult[]> {
  const deadlineAt = Date.now() + SHARED_RUN_DEADLINE_MS;

  const rotationChainSlug = options.rotationCursorKey?.chainSlug ?? POOL_ROTATION_CHAIN_SLUG;
  const rotationComponent = options.rotationCursorKey?.component ?? POOL_ROTATION_COMPONENT;
  const rotationState = pools.length > 0 ? await getIndexingState(rotationChainSlug, rotationComponent) : null;
  const rotationOffset = rotationState?.lastProcessedBlock ?? BigInt(0);
  const { batch: priorityPools, nextOffset } = selectRotatingBatch(pools, PRIORITY_BATCH_SIZE, rotationOffset);

  // Priority pools first (guaranteed attempted before the deadline can be
  // exhausted), then everyone else in their normal order - never shrinks
  // the pool list actually attempted, only reorders it.
  const priorityKeys = new Set(priorityPools.map((p) => p.key));
  const processingOrder = [...priorityPools, ...pools.filter((p) => !priorityKeys.has(p.key))];

  const resultByKey = new Map<string, PoolVolumeRunResult>();
  for (const pool of processingOrder) {
    try {
      resultByKey.set(pool.key, await indexPoolVolume(pool, deadlineAt));
    } catch (err) {
      resultByKey.set(pool.key, {
        poolKey: pool.key,
        ok: false,
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
        chunks: [],
        chunksCompleted: 0,
        chunksAttempted: 0,
      });
    }
  }

  if (pools.length > 0) {
    await updateIndexingState(rotationChainSlug, rotationComponent, { status: "idle", lastProcessedBlock: nextOffset, lastSuccessfulSyncAt: new Date() });
  }

  // Returned in the ORIGINAL pools order, not processing order - the
  // rotation only changes which pools win the deadline race, never the
  // shape/order callers already depend on.
  return pools.map((pool) => resultByKey.get(pool.key)!);
}
