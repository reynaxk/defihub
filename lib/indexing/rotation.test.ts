// Pure unit tests for selectRotatingBatch - this primitive has no dedicated
// test file anywhere in the codebase despite being reused by three separate
// jobs (volume/reorg.ts, volume/engine.ts, and now Phase 5.13's
// dynamic-engine.ts) - only ever exercised indirectly through those
// callers' own tests. Phase 5.13's own Part 15 explicitly asks for
// rotation/bounded-batch/fairness/no-starvation coverage, and this
// primitive is exactly what makes all of that true for the new dynamic
// pricing engine - worth testing directly, once, rather than a fourth time
// indirectly.
import { describe, expect, it } from "vitest";
import { selectRotatingBatch } from "./rotation";

describe("selectRotatingBatch", () => {
  it("returns the first batchSize items when starting at offset 0", () => {
    const { batch, nextOffset } = selectRotatingBatch(["a", "b", "c", "d", "e"], 2, BigInt(0));
    expect(batch).toEqual(["a", "b"]);
    expect(nextOffset).toBe(BigInt(2));
  });

  it("BOUNDED: never returns more than batchSize items, even when the list is much larger", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const { batch } = selectRotatingBatch(items, 40, BigInt(0));
    expect(batch).toHaveLength(40);
  });

  it("caps the batch to the list length when batchSize exceeds it, never throwing or returning duplicates", () => {
    const { batch } = selectRotatingBatch(["a", "b", "c"], 10, BigInt(0));
    expect(batch).toEqual(["a", "b", "c"]);
  });

  it("WRAPS: an offset partway through the list continues from there and wraps around the end back to the start", () => {
    const { batch, nextOffset } = selectRotatingBatch(["a", "b", "c", "d", "e"], 3, BigInt(4));
    expect(batch).toEqual(["e", "a", "b"]);
    expect(nextOffset).toBe(BigInt(7));
  });

  it("NO STARVATION: across enough successive calls (each one's nextOffset fed back in), every item is eventually included, not just the first batchSize", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const seen = new Set<string>();
    let offset = BigInt(0);
    for (let i = 0; i < 10; i++) {
      const { batch, nextOffset } = selectRotatingBatch(items, 2, offset);
      batch.forEach((item) => seen.add(item));
      offset = nextOffset;
    }
    expect(seen.size).toBe(items.length);
  });

  it("FAIRNESS: every item gets selected an equal (or near-equal) number of times over many successive calls, never permanently starving any one item", () => {
    const items = ["a", "b", "c", "d", "e"];
    const counts = new Map(items.map((i) => [i, 0]));
    let offset = BigInt(0);
    for (let i = 0; i < 20; i++) {
      const { batch, nextOffset } = selectRotatingBatch(items, 2, offset);
      batch.forEach((item) => counts.set(item, counts.get(item)! + 1));
      offset = nextOffset;
    }
    const counted = [...counts.values()];
    expect(Math.max(...counted) - Math.min(...counted)).toBeLessThanOrEqual(1);
  });

  it("RETRYABLE: a caller that never advances the offset (e.g. every item in a batch failed and the caller deliberately doesn't persist progress) sees the exact same batch again next call - a failed batch is naturally retried, not skipped", () => {
    const items = ["a", "b", "c"];
    const first = selectRotatingBatch(items, 2, BigInt(0));
    const retry = selectRotatingBatch(items, 2, BigInt(0)); // same offset, as if the caller never persisted nextOffset after a failure
    expect(retry.batch).toEqual(first.batch);
  });

  it("returns an empty batch (never throws) for an empty item list", () => {
    const { batch, nextOffset } = selectRotatingBatch([], 10, BigInt(5));
    expect(batch).toEqual([]);
    expect(nextOffset).toBe(BigInt(5)); // offset preserved unchanged - nothing to advance past
  });

  it("returns an empty batch (never throws) for a zero or negative batchSize", () => {
    expect(selectRotatingBatch(["a", "b"], 0, BigInt(0)).batch).toEqual([]);
    expect(selectRotatingBatch(["a", "b"], -1, BigInt(0)).batch).toEqual([]);
  });

  it("defensively normalizes an out-of-range offset (larger than the list length) rather than throwing", () => {
    const { batch } = selectRotatingBatch(["a", "b", "c"], 2, BigInt(100));
    expect(batch).toHaveLength(2);
  });

  it("stays correct when items are appended between calls - a growing candidate list (more pools discovered) never breaks the rotation", () => {
    let items = ["a", "b", "c"];
    const first = selectRotatingBatch(items, 2, BigInt(0));
    expect(first.batch).toEqual(["a", "b"]);

    items = [...items, "d", "e"]; // two new items discovered between runs
    const second = selectRotatingBatch(items, 2, first.nextOffset);
    expect(second.batch).toEqual(["c", "d"]);
  });
});
