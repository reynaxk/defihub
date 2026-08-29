import { parseAbiItem, type Address, type Log } from "viem";
import { backoffDelay, sleep, type BackoffOptions } from "@/lib/chains/backoff";
import { RpcUnavailableError, withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { getIndexingState, updateIndexingState } from "./state";

// Reusable primitives for incremental event-log ingestion. Phase 5 built
// the foundation (computeChunks/scanBlockRange, resumable checkpoints via
// scanFromCursor); Phase 5.5 makes scanFromCursor itself catch-up-aware -
// see this file's own module comment below for exactly what changed and
// why.

const DEFAULT_CHUNK_SIZE = BigInt(2000); // conservative - many public RPC providers cap eth_getLogs at 2000-10000 blocks/call

// Pure - the block-range chunking math, split out from scanBlockRange so it
// is directly unit-testable with no RPC/DB involved.
export function computeChunks(fromBlock: bigint, toBlock: bigint, chunkSize: bigint): [bigint, bigint][] {
  if (chunkSize <= BigInt(0)) throw new Error("computeChunks: chunkSize must be positive");
  const chunks: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - BigInt(1) > toBlock ? toBlock : start + chunkSize - BigInt(1);
    chunks.push([start, end]);
  }
  return chunks;
}

export interface ScanBlockRangeParams {
  chainSlug: string;
  address: Address;
  eventSignature: string; // human-readable, e.g. "event Swap(address indexed sender, ...)"
  fromBlock: bigint;
  toBlock: bigint;
  chunkSize?: bigint;
}

// Chunked eth_getLogs over [fromBlock, toBlock] - each chunk is its own
// withResilientClient call, so a mid-scan RPC failure retries/fails-over
// just that chunk rather than restarting the whole range. Still used
// as-is by callers that just want "every log in this range, combined" with
// no catch-up/resume semantics (e.g. a one-shot manual query) - the
// catch-up-aware, checkpoint-persisting orchestration lives in
// scanFromCursor below, which does NOT call this function (it needs
// per-chunk control this function's single combined return value doesn't
// give it).
export async function scanBlockRange(params: ScanBlockRangeParams): Promise<Log[]> {
  const { chainSlug, address, eventSignature, fromBlock, toBlock, chunkSize = DEFAULT_CHUNK_SIZE } = params;
  const event = parseAbiItem(eventSignature);
  if (event.type !== "event") {
    throw new Error(`scanBlockRange: not an event signature: "${eventSignature}"`);
  }

  const logs: Log[] = [];
  for (const [start, end] of computeChunks(fromBlock, toBlock, chunkSize)) {
    const chunkLogs = await withResilientClient(chainSlug, (client) =>
      client.getLogs({ address, event, fromBlock: start, toBlock: end }),
    );
    logs.push(...chunkLogs);
  }
  return logs;
}

export interface ScanChunk {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ScanFromCursorParams {
  chainSlug: string;
  // indexing_state key for this specific scan target, e.g.
  // "uniswap-v3-usdc-weth-swaps" - one row per (chainSlug, component).
  component: string;
  address: Address;
  eventSignature: string;
  // The chain head, typically from a prior getBlockNumber call - NOT
  // scanned to directly. See `confirmations` below.
  currentBlock: bigint;
  // Used only the first time this (chainSlug, component) has no persisted
  // cursor yet.
  startBlock: bigint;
  // The starting/maximum chunk size - see this file's own module comment
  // for how this can shrink (never grow) within one call when a provider
  // rejects a chunk for being too large.
  chunkSize?: bigint;
  // The floor a shrinking chunk size is never reduced below (Section 8's
  // "safe minimum chunk size") - once a chunk at this size still fails
  // with a range-limit rejection, that is treated as a genuine stop
  // condition (see stoppedReason on ScanResult), never an infinitely
  // shrinking loop.
  minChunkSize?: bigint;
  // Bounds the TOTAL number of chunk-fetch attempts this single call may
  // make (every distinct eth_getLogs call, including shrink-retries of the
  // same range at a smaller size) - Section 12's "every job/run must have
  // a bounded retry budget," applied at the chunk-planning layer (a
  // SEPARATE, already-bounded retry mechanism already exists one layer
  // down, inside withResilientClient, for transient per-request failures -
  // this budget is not a second copy of that, it bounds how many DISTINCT
  // chunk attempts - successful or not - one scanFromCursor call will make
  // before yielding control back to the caller/scheduler).
  maxChunkAttempts?: number;
  // Confirmation depth subtracted from currentBlock before it's used as
  // both the scan boundary and the persisted cursor. The chain head isn't
  // final - a reorg can orphan it, and once the cursor passes a height,
  // that range is never re-scanned: orphaned-block logs already delivered
  // to onLogs stay delivered (phantom data), and canonical replacement logs
  // for those heights are never fetched (missing data). The existing
  // (transactionHash, logIndex) idempotency dedup does not protect against
  // this - a reorged tx is typically dropped or re-included with a
  // different logIndex, not redelivered identically. Defaults to 0 for
  // callers that already pass a pre-confirmed height.
  confirmations?: bigint;
  // Phase 5.8 fix: epoch-ms deadline (typically `Date.now() +
  // someSafeMarginBelowTheCallerOwnServerlessMaxDuration`) this call must
  // stop BEFORE, checked at the top of the loop before starting each new
  // chunk attempt - never mid-chunk. Without this, maxChunkAttempts (100 by
  // default) has no relationship to a real caller's actual execution
  // ceiling (e.g. Vercel's `maxDuration = 60` on the cron routes that call
  // this): a large catch-up backlog can plausibly still be well within its
  // attempt budget when the PLATFORM kills the function first, which
  // produces an abrupt SIGKILL-equivalent instead of this module's own
  // graceful "partial" outcome with a real, diagnosable stoppedReason - the
  // per-chunk checkpointing already makes either case safe/idempotent (no
  // data corruption either way), but only the graceful stop is actually
  // observable in logs/sync_runs the way this module's own design intends.
  // Omitted (the default) preserves the exact previous behavior - no
  // deadline, bounded only by maxChunkAttempts - for any caller that
  // doesn't have (or doesn't want to think about) a serverless execution
  // ceiling.
  deadlineAt?: number;
  // Called once PER CHUNK (see this file's own module comment for why this
  // changed from Phase 5's original "called once for the whole run") with
  // that chunk's logs and its own [fromBlock, toBlock] boundaries - must
  // be idempotent (e.g. upsert keyed by (transactionHash, logIndex)),
  // since a crash between onLogs succeeding and the cursor write
  // immediately below it would otherwise reprocess that one chunk's range
  // next run (never more than one chunk's worth, now - see module
  // comment).
  onLogs: (logs: Log[], chunk: ScanChunk) => Promise<void>;
}

export type ScanOutcome = "success" | "partial";

export interface ScanResult {
  scannedFrom: bigint;
  // The last block actually, successfully processed and checkpointed this
  // call - equal to the originally-intended safe head only when outcome is
  // "success". Never claim coverage through a block that was not actually
  // processed (Section 25).
  scannedTo: bigint;
  logCount: number;
  // "success": every chunk in the intended [fromBlock, safeHead] range was
  // processed. "partial": real, checkpointed progress was made (at least
  // one chunk completed) but the run stopped before reaching the safe
  // head - a provider range limit at the minimum chunk size, or the
  // per-call attempt budget was exhausted. Never thrown as an exception -
  // partial progress is an expected, recoverable outcome the caller should
  // be able to inspect, not treated as a hard failure. Contrast with an
  // actual thrown error (no chunk succeeded at all this call, or onLogs
  // itself threw) - see this file's own module comment.
  outcome: ScanOutcome;
  chunksCompleted: number;
  chunksAttempted: number;
  // Set only when outcome is "partial" - a short, stable machine-readable
  // reason (see the RANGE_LIMIT_AT_MINIMUM/RPC_UNAVAILABLE/
  // ATTEMPT_BUDGET_EXHAUSTED constants below), for structured logs and for
  // callers that want to react differently to different stop reasons.
  stoppedReason?: string;
}

export const STOP_REASON = {
  RANGE_LIMIT_AT_MINIMUM: "range-limit-at-minimum-chunk-size",
  RPC_UNAVAILABLE: "rpc-unavailable",
  ATTEMPT_BUDGET_EXHAUSTED: "attempt-budget-exhausted",
  // Phase 5.8: stopped because `deadlineAt` was reached, not because
  // anything failed - see ScanFromCursorParams.deadlineAt's own comment.
  DEADLINE_APPROACHING: "deadline-approaching",
} as const;

const DEFAULT_MIN_CHUNK_SIZE = BigInt(10);
const DEFAULT_MAX_CHUNK_ATTEMPTS = 100;
const SHRINK_BACKOFF: BackoffOptions = { baseDelayMs: 500, maxDelayMs: 8000 };

// Returns true only when the RPC failure was specifically a block-range
// rejection (see lib/chains/rpc-errors.ts's own "range-limit" category) -
// the one failure kind this loop knows how to recover from by itself
// (shrink and retry). Every other RpcUnavailableError (transient/timeout/
// rate-limit exhausted across every configured provider, or a genuinely
// permanent/malformed failure) is NOT retried at this layer - see this
// file's own module comment for why piling a second retry loop on top of
// withResilientClient's own bounded, already-thorough one would just be
// duplicated retry logic (Section 48) for no real benefit; the scheduler
// (the next cron invocation) is the right place for that retry to happen.
function isRangeLimitFailure(err: unknown): boolean {
  return err instanceof RpcUnavailableError && err.attempts.some((a) => a.kind === "range-limit");
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// Resumes from the persisted cursor (lastProcessedBlock + 1) or startBlock
// on a first run, and processes the safe range in bounded chunks - one
// eth_getLogs call, one onLogs call, and one durably-persisted checkpoint
// advance PER CHUNK, not once for the whole range.
//
// Phase 5.5 rewrite, and exactly why: Phase 5's original version fetched
// EVERY chunk in the range first (scanBlockRange's own internal loop),
// combined every chunk's logs into one array, and only THEN called onLogs
// once and advanced the cursor once, for the whole range. That is safe
// (a mid-range failure means nothing was processed and the cursor never
// moves, so a retry cannot double-count anything) but has no PARTIAL
// progress: a large gap (a stale cursor from downtime, an RPC outage, a
// crashed process) had to be re-fetched from its own original start on
// every single retry, forever, if the gap was large enough that some
// portion of it kept failing. This is the exact operational failure mode
// Phase 5.4's own final report flagged as a known limitation, and what
// Phase 5.5 exists to fix: a checkpoint now advances after EVERY
// successfully completed chunk, so a crash/failure partway through a long
// catch-up preserves everything completed so far - the next invocation
// resumes exactly at the next unprocessed chunk, never redoing completed
// work and never skipping ahead past what actually succeeded.
//
// Adaptive range shrinking (Section 7/8/22): a chunk that fails because a
// provider rejected the range as too large (classified "range-limit" -
// lib/chains/rpc-errors.ts) is retried at half the chunk size (never below
// minChunkSize), with the remaining plan recomputed from the same
// unadvanced starting point - the failing chunk is never skipped, and the
// cursor never advances past it. A range-limit failure that persists even
// at minChunkSize (every configured provider - see withResilientClient -
// still rejects the smallest allowed range) stops the run cleanly,
// reporting `outcome: "partial"` with `stoppedReason` set, rather than
// looping forever or fabricating success.
//
// Never advances the cursor past a chunk that did not itself complete
// successfully (Invariant 1) - this is true whether the run completes
// every chunk, stops partway through a provider limitation, or has onLogs
// itself throw partway through (in which case this whole call rejects,
// exactly as Phase 5's original version did for its one, whole-range
// "chunk" - only the granularity of what "one chunk" means changed).
export async function scanFromCursor(params: ScanFromCursorParams): Promise<ScanResult> {
  const {
    chainSlug,
    component,
    address,
    eventSignature,
    currentBlock,
    startBlock,
    chunkSize = DEFAULT_CHUNK_SIZE,
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
    maxChunkAttempts = DEFAULT_MAX_CHUNK_ATTEMPTS,
    confirmations = BigInt(0),
    deadlineAt,
    onLogs,
  } = params;
  const event = parseAbiItem(eventSignature);
  if (event.type !== "event") {
    throw new Error(`scanFromCursor: not an event signature: "${eventSignature}"`);
  }

  // Never scan to (or persist a cursor at) the unconfirmed tip - see
  // `confirmations` above.
  const safeToBlock = currentBlock > confirmations ? currentBlock - confirmations : BigInt(0);

  await updateIndexingState(chainSlug, component, { status: "running", lastAttemptedSyncAt: new Date() });

  try {
    const state = await getIndexingState(chainSlug, component);
    const fromBlock = state?.lastProcessedBlock != null ? state.lastProcessedBlock + BigInt(1) : startBlock;

    if (fromBlock > safeToBlock) {
      await updateIndexingState(chainSlug, component, { status: "idle", lastSuccessfulSyncAt: new Date() });
      return { scannedFrom: fromBlock, scannedTo: fromBlock - BigInt(1), logCount: 0, outcome: "success", chunksCompleted: 0, chunksAttempted: 0 };
    }

    let plan = computeChunks(fromBlock, safeToBlock, chunkSize);
    let currentChunkSize = chunkSize;
    let planIndex = 0;
    let attempts = 0;
    let chunksCompleted = 0;
    let totalLogCount = 0;
    let cursorAdvancedTo: bigint | null = null;
    let stoppedReason: (typeof STOP_REASON)[keyof typeof STOP_REASON] | undefined;
    let stoppingError: unknown;

    while (planIndex < plan.length) {
      if (attempts >= maxChunkAttempts) {
        stoppedReason = STOP_REASON.ATTEMPT_BUDGET_EXHAUSTED;
        break;
      }
      // Checked BEFORE starting a new chunk attempt, never mid-chunk - see
      // deadlineAt's own comment above. An in-flight chunk's own RPC call/
      // onLogs write is never interrupted by this check.
      if (deadlineAt != null && Date.now() >= deadlineAt) {
        stoppedReason = STOP_REASON.DEADLINE_APPROACHING;
        break;
      }
      attempts++;
      const [start, end] = plan[planIndex];

      let logs: Log[];
      try {
        logs = await withResilientClient(chainSlug, (client) => client.getLogs({ address, event, fromBlock: start, toBlock: end }));
      } catch (err) {
        if (isRangeLimitFailure(err) && currentChunkSize > minChunkSize) {
          currentChunkSize = maxBigInt(minChunkSize, currentChunkSize / BigInt(2));
          plan = [...plan.slice(0, planIndex), ...computeChunks(start, safeToBlock, currentChunkSize)];
          await sleep(backoffDelay(attempts, SHRINK_BACKOFF));
          continue; // retry at planIndex - now the smaller first sub-chunk of the same starting point
        }
        stoppedReason = isRangeLimitFailure(err) ? STOP_REASON.RANGE_LIMIT_AT_MINIMUM : STOP_REASON.RPC_UNAVAILABLE;
        stoppingError = err;
        break;
      }

      // onLogs is called and awaited OUTSIDE the try/catch above -
      // deliberately never caught here. A decoding/persistence failure is
      // a data-integrity concern, not a recoverable RPC condition, and
      // must propagate immediately (see the outer catch below), exactly as
      // Phase 5's original version did.
      await onLogs(logs, { fromBlock: start, toBlock: end });
      totalLogCount += logs.length;
      chunksCompleted++;
      cursorAdvancedTo = end;
      planIndex++;

      // Persisted immediately, per chunk - not batched until the end of
      // the loop - so a crash on the very next line still leaves this
      // chunk's progress durable or the next invocation to resume from.
      await updateIndexingState(chainSlug, component, { status: "idle", lastProcessedBlock: end, lastSuccessfulSyncAt: new Date() });
    }

    if (planIndex >= plan.length) {
      return { scannedFrom: fromBlock, scannedTo: safeToBlock, logCount: totalLogCount, outcome: "success", chunksCompleted, chunksAttempted: attempts };
    }

    // Stopped before completing the plan. No chunk succeeded at all this
    // call - Section 26's "failed" (no meaningful progress) - surfaces as
    // a genuine thrown error, the same contract a total failure has always
    // had.
    //
    // Phase 5.8 exception: a deadline stop with zero chunks completed means
    // this call never even ATTEMPTED a chunk (e.g. a shared cross-pool time
    // budget was already exhausted by an earlier pool/chain in the same
    // invocation - see deadlineAt's own comment) - nothing failed, this
    // pool simply didn't get a turn this run. Treating that as a thrown
    // "failed" error would misreport a healthy pool as broken to callers
    // like indexAllPoolVolume's own per-pool try/catch. Reported as
    // "partial" with zero progress instead, so the next invocation picks up
    // from exactly the same, unchanged cursor.
    if (cursorAdvancedTo == null) {
      if (stoppedReason === STOP_REASON.DEADLINE_APPROACHING) {
        await updateIndexingState(chainSlug, component, {
          status: "idle",
          error: "skipped this run - shared time budget was already exhausted before this component's turn",
        });
        return { scannedFrom: fromBlock, scannedTo: fromBlock - BigInt(1), logCount: 0, outcome: "partial", chunksCompleted: 0, chunksAttempted: attempts, stoppedReason };
      }
      const message = stoppingError instanceof Error ? stoppingError.message : `scanFromCursor stopped before any chunk completed: ${stoppedReason}`;
      throw new Error(message);
    }

    // Real, checkpointed progress occurred, but the run stopped short of
    // the safe head - Section 26's "partial". Returned normally, not
    // thrown: this is an expected, recoverable outcome the next
    // invocation will continue from exactly where this one left off.
    // Section 36's observability: the underlying RPC failure detail
    // (provider, attempt count, redacted URL - see RpcUnavailableError's
    // own message) is folded into the persisted error text when
    // available, not just the short machine-readable stoppedReason code -
    // so "why is this chain behind" is answerable from indexing_state
    // alone, without needing to cross-reference platform logs.
    const stoppingDetail = stoppingError instanceof Error ? stoppingError.message : undefined;
    await updateIndexingState(chainSlug, component, {
      status: "error",
      error: `stopped after ${chunksCompleted} chunk(s): ${stoppedReason}${stoppingDetail ? ` - ${stoppingDetail}` : ""}`,
    });
    return { scannedFrom: fromBlock, scannedTo: cursorAdvancedTo, logCount: totalLogCount, outcome: "partial", chunksCompleted, chunksAttempted: attempts, stoppedReason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateIndexingState(chainSlug, component, { status: "error", error: message });
    throw err;
  }
}
