import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcUnavailableError } from "@/lib/chains/rpc-resilient-client";
import { computeChunks, STOP_REASON } from "./events";

describe("computeChunks", () => {
  it("splits an exact multiple of chunkSize into equal chunks", () => {
    expect(computeChunks(BigInt(0), BigInt(5999), BigInt(2000))).toEqual([
      [BigInt(0), BigInt(1999)],
      [BigInt(2000), BigInt(3999)],
      [BigInt(4000), BigInt(5999)],
    ]);
  });

  it("caps the final chunk at toBlock when the range doesn't divide evenly", () => {
    expect(computeChunks(BigInt(0), BigInt(4500), BigInt(2000))).toEqual([
      [BigInt(0), BigInt(1999)],
      [BigInt(2000), BigInt(3999)],
      [BigInt(4000), BigInt(4500)],
    ]);
  });

  it("returns a single chunk when the range fits within chunkSize", () => {
    expect(computeChunks(BigInt(100), BigInt(150), BigInt(2000))).toEqual([[BigInt(100), BigInt(150)]]);
  });

  it("returns a single-block chunk when fromBlock equals toBlock", () => {
    expect(computeChunks(BigInt(42), BigInt(42), BigInt(2000))).toEqual([[BigInt(42), BigInt(42)]]);
  });

  it("returns no chunks when fromBlock is after toBlock", () => {
    expect(computeChunks(BigInt(100), BigInt(50), BigInt(2000))).toEqual([]);
  });

  it("throws for a non-positive chunkSize", () => {
    expect(() => computeChunks(BigInt(0), BigInt(100), BigInt(0))).toThrow();
  });
});

const mockGetLogs = vi.fn();
vi.mock("@/lib/chains/rpc-resilient-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/chains/rpc-resilient-client")>();
  return {
    ...actual,
    withResilientClient: (_chainSlug: string, fn: (client: { getLogs: typeof mockGetLogs }) => unknown) => fn({ getLogs: mockGetLogs }),
  };
});

const mockGetIndexingState = vi.fn();
const mockUpdateIndexingState = vi.fn();
vi.mock("./state", () => ({
  getIndexingState: (...args: unknown[]) => mockGetIndexingState(...args),
  updateIndexingState: (...args: unknown[]) => mockUpdateIndexingState(...args),
}));

const { scanFromCursor } = await import("./events");

const SWAP_EVENT = "event Swap(address indexed sender, uint256 amount)";

describe("scanFromCursor", () => {
  beforeEach(() => {
    mockGetLogs.mockReset();
    mockGetIndexingState.mockReset();
    mockUpdateIndexingState.mockReset().mockResolvedValue(undefined);
  });

  it("uses startBlock when no cursor exists yet, then persists the new cursor", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([{ transactionHash: "0xabc", logIndex: 0 }]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(100),
      startBlock: BigInt(50),
      onLogs,
    });

    expect(result).toEqual({
      scannedFrom: BigInt(50),
      scannedTo: BigInt(100),
      logCount: 1,
      outcome: "success",
      chunksCompleted: 1,
      chunksAttempted: 1,
    });
    expect(onLogs).toHaveBeenCalledWith([{ transactionHash: "0xabc", logIndex: 0 }], { fromBlock: BigInt(50), toBlock: BigInt(100) });
    expect(mockUpdateIndexingState).toHaveBeenLastCalledWith(
      "ethereum",
      "test-component",
      expect.objectContaining({ status: "idle", lastProcessedBlock: BigInt(100) }),
    );
  });

  it("resumes from lastProcessedBlock + 1 when a cursor already exists", async () => {
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(200) });
    mockGetLogs.mockResolvedValue([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(300),
      startBlock: BigInt(0),
      onLogs,
    });

    expect(result.scannedFrom).toBe(BigInt(201));
    expect(result.scannedTo).toBe(BigInt(300));
  });

  it("does nothing and reports zero logs when already caught up to currentBlock", async () => {
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(500) });
    const onLogs = vi.fn();

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(500),
      startBlock: BigInt(0),
      onLogs,
    });

    expect(result.logCount).toBe(0);
    expect(onLogs).not.toHaveBeenCalled();
    expect(mockGetLogs).not.toHaveBeenCalled();
  });

  it("scans only up to currentBlock minus confirmations, and persists that as the cursor", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(1000),
      startBlock: BigInt(0),
      confirmations: BigInt(12),
      onLogs,
    });

    expect(result.scannedTo).toBe(BigInt(988));
    expect(mockGetLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: BigInt(0), toBlock: BigInt(988) }),
    );
    expect(mockUpdateIndexingState).toHaveBeenLastCalledWith(
      "ethereum",
      "test-component",
      expect.objectContaining({ status: "idle", lastProcessedBlock: BigInt(988) }),
    );
  });

  it("does not invert the range or advance the cursor when the confirmed head is behind the persisted cursor", async () => {
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(500) });
    const onLogs = vi.fn();

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      // A reorg (or a stale head read) puts the confirmed height behind
      // the cursor already persisted from a prior run.
      currentBlock: BigInt(505),
      startBlock: BigInt(0),
      confirmations: BigInt(12),
      onLogs,
    });

    expect(result.logCount).toBe(0);
    expect(onLogs).not.toHaveBeenCalled();
    expect(mockGetLogs).not.toHaveBeenCalled();
    expect(mockUpdateIndexingState).not.toHaveBeenCalledWith(
      "ethereum",
      "test-component",
      expect.objectContaining({ lastProcessedBlock: expect.anything() }),
    );
  });

  it("marks the state as error and does not advance the cursor when onLogs throws", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([{ transactionHash: "0xabc", logIndex: 0 }]);
    const onLogs = vi.fn().mockRejectedValue(new Error("db write failed"));

    await expect(
      scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(100),
        startBlock: BigInt(50),
        onLogs,
      }),
    ).rejects.toThrow("db write failed");

    const lastCall = mockUpdateIndexingState.mock.calls.at(-1);
    expect(lastCall?.[2]).toMatchObject({ status: "error", error: "db write failed" });
    // Not just the last call - a regression that persisted
    // lastProcessedBlock in an earlier call before the final error-status
    // call would otherwise still pass.
    for (const call of mockUpdateIndexingState.mock.calls) {
      expect(call[2]).not.toHaveProperty("lastProcessedBlock");
    }
  });
});

// Phase 5.5's own test matrix: multi-chunk catch-up, crash/resume, adaptive
// range-limit shrinking, and the bounded attempt budget. Every test here
// uses the same mocked withResilientClient/getIndexingState/
// updateIndexingState as the suite above - only the SHAPE of what
// mockGetLogs returns/rejects across successive calls changes.
describe("scanFromCursor - multi-chunk catch-up (Phase 5.5)", () => {
  beforeEach(() => {
    mockGetLogs.mockReset();
    mockGetIndexingState.mockReset();
    mockUpdateIndexingState.mockReset().mockResolvedValue(undefined);
  });

  it("processes a large gap across multiple chunks, checkpointing durably after EACH one (not just at the end)", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs
      .mockResolvedValueOnce([{ transactionHash: "0xa", logIndex: 0 }])
      .mockResolvedValueOnce([{ transactionHash: "0xb", logIndex: 0 }, { transactionHash: "0xc", logIndex: 1 }])
      .mockResolvedValueOnce([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(5999),
      startBlock: BigInt(0),
      chunkSize: BigInt(2000),
      onLogs,
    });

    expect(result).toEqual({
      scannedFrom: BigInt(0),
      scannedTo: BigInt(5999),
      logCount: 3,
      outcome: "success",
      chunksCompleted: 3,
      chunksAttempted: 3,
    });
    expect(onLogs).toHaveBeenNthCalledWith(1, expect.anything(), { fromBlock: BigInt(0), toBlock: BigInt(1999) });
    expect(onLogs).toHaveBeenNthCalledWith(2, expect.anything(), { fromBlock: BigInt(2000), toBlock: BigInt(3999) });
    expect(onLogs).toHaveBeenNthCalledWith(3, expect.anything(), { fromBlock: BigInt(4000), toBlock: BigInt(5999) });

    // Every chunk's own checkpoint was persisted separately, in order -
    // never batched into a single write at the end (Section 16/17's crash
    // safety depends on this).
    const cursorWrites = mockUpdateIndexingState.mock.calls
      .filter((c) => "lastProcessedBlock" in (c[2] as object))
      .map((c) => (c[2] as { lastProcessedBlock: bigint }).lastProcessedBlock);
    expect(cursorWrites).toEqual([BigInt(1999), BigInt(3999), BigInt(5999)]);
  });

  it("resumes from the exact next unprocessed chunk after a run crashes partway through catch-up - never redoes completed chunks, never skips ahead (Section 16)", async () => {
    // Run 1: chunks 1000-1499 and 1500-1999 succeed; the process then
    // "crashes" attempting chunk 2000-2499 (a genuine, unrecoverable RPC
    // failure - not shrinkable).
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs
      .mockResolvedValueOnce([{ transactionHash: "0x1", logIndex: 0 }])
      .mockResolvedValueOnce([{ transactionHash: "0x2", logIndex: 0 }])
      .mockRejectedValueOnce(new RpcUnavailableError("ethereum", [{ url: "https://x", kind: "transient", message: "connection reset" }]));
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const run1 = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(2499),
      startBlock: BigInt(1000),
      chunkSize: BigInt(500),
      onLogs,
    });

    expect(run1.outcome).toBe("partial");
    expect(run1.scannedTo).toBe(BigInt(1999));
    expect(run1.chunksCompleted).toBe(2);
    expect(run1.stoppedReason).toBe(STOP_REASON.RPC_UNAVAILABLE);

    // Run 2 ("next invocation"): the persisted cursor now reflects run 1's
    // real progress.
    mockGetLogs.mockReset();
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(1999) });
    mockGetLogs.mockResolvedValue([]);

    await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(2499),
      startBlock: BigInt(1000),
      chunkSize: BigInt(500),
      onLogs,
    });

    // MUST resume at 2000 - not 1000 (redoing completed work) and not
    // some other "current safe head"-derived value.
    expect(mockGetLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: BigInt(2000), toBlock: BigInt(2499) }));
  });

  it("throws (never reports partial) when the very first chunk fails and no progress was made at all - Section 26's 'failed'", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockRejectedValue(new RpcUnavailableError("ethereum", [{ url: "https://x", kind: "transient", message: "connection reset" }]));
    const onLogs = vi.fn().mockResolvedValue(undefined);

    await expect(
      scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(999),
        startBlock: BigInt(0),
        chunkSize: BigInt(2000),
        onLogs,
      }),
    ).rejects.toThrow();

    expect(onLogs).not.toHaveBeenCalled();
    for (const call of mockUpdateIndexingState.mock.calls) {
      expect(call[2]).not.toHaveProperty("lastProcessedBlock");
    }
  });

  // Shrink retries sleep (backoffDelay) between attempts - fake timers let
  // these tests assert real shrink-sequence behavior without the suite
  // actually waiting out the backoff in wall-clock time (same convention
  // rpc-resilient-client.test.ts already established for its own retries).
  it("shrinks the chunk size and retries the SAME starting point (never skips it) when a provider rejects the range as too large", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs
      // Original chunk [1000, 1999] (chunkSize 1000) - rejected as too large.
      .mockRejectedValueOnce(
        new RpcUnavailableError("ethereum", [{ url: "https://x", kind: "range-limit", message: "block range is too large" }]),
      )
      // Retried at half the size: [1000, 1499] - succeeds.
      .mockResolvedValueOnce([{ transactionHash: "0xshrunk", logIndex: 0 }])
      // Remaining: [1500, 1999] - succeeds.
      .mockResolvedValueOnce([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    const resultPromise = scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(1999),
      startBlock: BigInt(1000),
      chunkSize: BigInt(1000),
      onLogs,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.outcome).toBe("success");
    expect(result.chunksCompleted).toBe(2);
    expect(result.scannedTo).toBe(BigInt(1999));
    // The retried call covers the SAME starting block (1000), never skips
    // it, at half the original size.
    expect(mockGetLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({ fromBlock: BigInt(1000), toBlock: BigInt(1499) }));
    expect(mockGetLogs).toHaveBeenNthCalledWith(3, expect.objectContaining({ fromBlock: BigInt(1500), toBlock: BigInt(1999) }));
  });

  it("stops cleanly (never loops forever) when a range-limit rejection persists all the way down to the configured minimum chunk size", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    const rangeLimitError = new RpcUnavailableError("ethereum", [{ url: "https://x", kind: "range-limit", message: "archive node required" }]);
    // 800 -> 400 -> 200 -> 100 (== minChunkSize): every attempt rejected.
    mockGetLogs.mockRejectedValue(rangeLimitError);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    const resultPromise = scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(1799),
      startBlock: BigInt(1000),
      chunkSize: BigInt(800),
      minChunkSize: BigInt(100),
      onLogs,
    });
    const assertion = expect(resultPromise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    // 800, 400, 200, 100 - four attempts, then stop (100 is not > 100, so
    // no fifth, further-shrunk attempt is ever made).
    const requestedSizes = mockGetLogs.mock.calls.map((c) => {
      const { fromBlock, toBlock } = c[0] as { fromBlock: bigint; toBlock: bigint };
      return toBlock - fromBlock + BigInt(1);
    });
    expect(requestedSizes).toEqual([BigInt(800), BigInt(400), BigInt(200), BigInt(100)]);
    expect(onLogs).not.toHaveBeenCalled();
  });

  it("reports partial with stoppedReason=range-limit-at-minimum when minimum-size shrinking fails on a chunk AFTER real progress already happened", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    const rangeLimitError = new RpcUnavailableError("ethereum", [{ url: "https://x", kind: "range-limit", message: "archive node required" }]);
    mockGetLogs
      .mockResolvedValueOnce([]) // chunk 1 (1000-1999) succeeds
      .mockRejectedValue(rangeLimitError); // every attempt on chunk 2 onward rejects, down to the minimum
    const onLogs = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    const resultPromise = scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(2999),
      startBlock: BigInt(1000),
      chunkSize: BigInt(1000),
      minChunkSize: BigInt(250),
      onLogs,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.outcome).toBe("partial");
    expect(result.stoppedReason).toBe(STOP_REASON.RANGE_LIMIT_AT_MINIMUM);
    expect(result.scannedTo).toBe(BigInt(1999)); // chunk 1's own end - real progress preserved
    expect(result.chunksCompleted).toBe(1);
  });

  // Section 37's performance requirement, verified against a scale beyond
  // what this app's own single live-configured pool has ever actually
  // needed to catch up in one run: a real, large catch-up gap processes as
  // MANY small RPC calls as chunks require (never more - no per-block or
  // per-event RPC calls), and the loop's own bookkeeping overhead per
  // chunk stays flat rather than compounding, so a 100-chunk catch-up
  // completes in a bounded, small amount of wall-clock time rather than
  // degrading as the gap grows.
  it("processes a large number of chunks (a realistic long catch-up gap) with bounded, non-degrading overhead", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);
    const chunkCount = 100;

    const startedAt = Date.now();
    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(chunkCount * 50 - 1),
      startBlock: BigInt(0),
      chunkSize: BigInt(50),
      maxChunkAttempts: chunkCount,
      onLogs,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe("success");
    expect(result.chunksCompleted).toBe(chunkCount);
    expect(mockGetLogs).toHaveBeenCalledTimes(chunkCount); // exactly one RPC call per chunk, never per block/event
    expect(elapsedMs).toBeLessThan(2000); // no per-chunk overhead compounding into a slow loop
  });

  it("stops with attempt-budget-exhausted when maxChunkAttempts is reached mid-catch-up, preserving whatever already succeeded", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([]); // every chunk would succeed if attempted
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(5999), // 3 possible chunks at chunkSize 2000
      startBlock: BigInt(0),
      chunkSize: BigInt(2000),
      maxChunkAttempts: 2,
      onLogs,
    });

    expect(result.outcome).toBe("partial");
    expect(result.stoppedReason).toBe(STOP_REASON.ATTEMPT_BUDGET_EXHAUSTED);
    expect(result.chunksCompleted).toBe(2);
    expect(result.chunksAttempted).toBe(2);
    expect(result.scannedTo).toBe(BigInt(3999)); // only the first 2 of 3 chunks were allowed to run
  });

  // Phase 5.8: deadlineAt - a soft internal deadline (typically derived from
  // a caller's real serverless maxDuration) so a large catch-up backlog
  // stops gracefully with a real stoppedReason instead of plausibly getting
  // killed by the platform mid-run, well within maxChunkAttempts's own
  // budget - see deadlineAt's own comment in events.ts.
  describe("deadlineAt", () => {
    it("stops gracefully (partial, not thrown) when the deadline has already passed before ANY chunk is attempted", async () => {
      mockGetIndexingState.mockResolvedValue(null);
      mockGetLogs.mockResolvedValue([]); // every chunk would succeed if attempted
      const onLogs = vi.fn().mockResolvedValue(undefined);

      const result = await scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(5999),
        startBlock: BigInt(0),
        chunkSize: BigInt(2000),
        deadlineAt: Date.now() - 1, // already in the past
        onLogs,
      });

      // The real bug this fix closes: zero chunks completed used to ALWAYS
      // throw ("failed"), even when the true reason was simply "never got
      // a turn this run" rather than anything actually failing.
      expect(result.outcome).toBe("partial");
      expect(result.stoppedReason).toBe(STOP_REASON.DEADLINE_APPROACHING);
      expect(result.chunksCompleted).toBe(0);
      expect(onLogs).not.toHaveBeenCalled();
      expect(mockGetLogs).not.toHaveBeenCalled();
      // The cursor must stay exactly where it was - untouched, not
      // regressed - so the next invocation resumes from the same place.
      for (const call of mockUpdateIndexingState.mock.calls) {
        expect(call[2]).not.toHaveProperty("lastProcessedBlock");
      }
    });

    it("preserves real progress and reports partial when the deadline is reached mid-catch-up, after some chunks already completed", async () => {
      mockGetIndexingState.mockResolvedValue(null);
      const onLogs = vi.fn().mockResolvedValue(undefined);

      // Fake timers so the deadline check is deterministic rather than
      // racing real wall-clock time: the first chunk's own fetch pushes the
      // fake clock past the deadline before resolving, so the loop's next
      // top-of-iteration check (before attempting a second chunk) sees it
      // as already passed.
      vi.useFakeTimers();
      const deadlineAt = Date.now() + 1000;
      mockGetLogs
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(2000);
          return [];
        })
        .mockResolvedValue([]); // would succeed if a second chunk were ever attempted

      const resultPromise = scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(5999),
        startBlock: BigInt(0),
        chunkSize: BigInt(2000),
        deadlineAt,
        onLogs,
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.outcome).toBe("partial");
      expect(result.stoppedReason).toBe(STOP_REASON.DEADLINE_APPROACHING);
      expect(result.chunksCompleted).toBe(1);
      expect(result.scannedTo).toBe(BigInt(1999)); // only the first chunk's own progress
      expect(mockGetLogs).toHaveBeenCalledTimes(1); // never started a second chunk past the deadline
    });

    it("is unaffected when deadlineAt is omitted - existing callers keep their exact previous behavior", async () => {
      mockGetIndexingState.mockResolvedValue(null);
      mockGetLogs.mockResolvedValue([{ transactionHash: "0xabc", logIndex: 0 }]);
      const onLogs = vi.fn().mockResolvedValue(undefined);

      const result = await scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(100),
        startBlock: BigInt(50),
        onLogs,
      });

      expect(result.outcome).toBe("success");
      expect(result.stoppedReason).toBeUndefined();
    });
  });
});

// Section 41's property/boundary tests for the chunk planner - every block
// in [fromBlock, toBlock] is covered exactly once, with no gap.
describe("computeChunks - coverage properties", () => {
  function assertContiguousCoverage(fromBlock: bigint, toBlock: bigint, chunkSize: bigint) {
    const chunks = computeChunks(fromBlock, toBlock, chunkSize);
    expect(chunks[0]?.[0]).toBe(fromBlock);
    expect(chunks.at(-1)?.[1]).toBe(toBlock);
    for (let i = 0; i < chunks.length; i++) {
      const [start, end] = chunks[i];
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end - start + BigInt(1)).toBeLessThanOrEqual(chunkSize); // Section 41: no chunk exceeds max range
      if (i > 0) {
        // No gap and no unintentional overlap between consecutive chunks.
        expect(start).toBe(chunks[i - 1][1] + BigInt(1));
      }
    }
  }

  it("covers a range that divides evenly with no gaps", () => {
    assertContiguousCoverage(BigInt(0), BigInt(9999), BigInt(1000));
  });

  it("covers a range that does not divide evenly with no gaps", () => {
    assertContiguousCoverage(BigInt(7), BigInt(10003), BigInt(777));
  });

  it("covers a range narrower than one chunk with no gaps", () => {
    assertContiguousCoverage(BigInt(500), BigInt(510), BigInt(2000));
  });

  it("covers a large, realistic catch-up gap (millions of blocks) with no gaps", () => {
    assertContiguousCoverage(BigInt(1_000_000), BigInt(4_500_000), BigInt(50_000));
  });
});
