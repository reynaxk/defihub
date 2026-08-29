// Pure unit tests for selectReorgRecheckBatch (lib/onchain/volume/reorg.ts) -
// no DB, no RPC, just the round-robin windowing math itself. See
// reorg.integration.test.ts's own new "REGRESSION" test for proof that the
// persisted offset this function consumes/produces actually round-trips
// through indexing_state correctly across real recheckVolumeReorgs calls.
import { describe, expect, it } from "vitest";
import { selectReorgRecheckBatch } from "./reorg";

describe("selectReorgRecheckBatch", () => {
  it("returns the first `batchSize` items starting at offset 0", () => {
    const { batch, nextOffset } = selectReorgRecheckBatch(["a", "b", "c", "d", "e"], 2, BigInt(0));
    expect(batch).toEqual(["a", "b"]);
    expect(nextOffset).toBe(BigInt(2));
  });

  it("continues from a nonzero offset", () => {
    const { batch, nextOffset } = selectReorgRecheckBatch(["a", "b", "c", "d", "e"], 2, BigInt(2));
    expect(batch).toEqual(["c", "d"]);
    expect(nextOffset).toBe(BigInt(4));
  });

  it("wraps around the end of the list back to the start", () => {
    const { batch, nextOffset } = selectReorgRecheckBatch(["a", "b", "c", "d", "e"], 2, BigInt(4));
    expect(batch).toEqual(["e", "a"]);
    expect(nextOffset).toBe(BigInt(6));
  });

  it("REGRESSION (CodeRabbit PR #17): across enough successive calls, every pool in a list larger than batchSize eventually gets included - not just the first `batchSize`", () => {
    const pools = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const batchSize = 3;
    let offset = BigInt(0);
    const seen = new Set<string>();

    // 3 runs of batchSize 3 covers at least 9 slots >= 7 pools, guaranteeing
    // full coverage even with wraparound overlap.
    for (let i = 0; i < 3; i++) {
      const { batch, nextOffset } = selectReorgRecheckBatch(pools, batchSize, offset);
      for (const p of batch) seen.add(p);
      offset = nextOffset;
    }

    expect(seen.size).toBe(pools.length);
  });

  it("offset never resets backward across a full lap - nextOffset is always strictly increasing, compatible with GREATEST()-protected cursor storage", () => {
    const pools = ["a", "b", "c"];
    let offset = BigInt(0);
    let previous = offset;
    for (let i = 0; i < 10; i++) {
      const { nextOffset } = selectReorgRecheckBatch(pools, 2, offset);
      expect(nextOffset).toBeGreaterThan(previous);
      previous = nextOffset;
      offset = nextOffset;
    }
  });

  it("handles a batchSize larger than the pool count by returning every pool exactly once, not repeating any", () => {
    const { batch, nextOffset } = selectReorgRecheckBatch(["a", "b", "c"], 10, BigInt(0));
    expect(batch).toEqual(["a", "b", "c"]);
    expect(nextOffset).toBe(BigInt(3));
  });

  it("returns an empty batch and an unchanged offset for an empty pool list", () => {
    const { batch, nextOffset } = selectReorgRecheckBatch([], 5, BigInt(7));
    expect(batch).toEqual([]);
    expect(nextOffset).toBe(BigInt(7));
  });

  it("returns an empty batch and an unchanged offset for a zero or negative batchSize", () => {
    expect(selectReorgRecheckBatch(["a", "b"], 0, BigInt(3))).toEqual({ batch: [], nextOffset: BigInt(3) });
    expect(selectReorgRecheckBatch(["a", "b"], -1, BigInt(3))).toEqual({ batch: [], nextOffset: BigInt(3) });
  });

  it("normalizes an offset already larger than the pool count (defensive - should not occur via normal use, since nextOffset only ever grows by n)", () => {
    const { batch } = selectReorgRecheckBatch(["a", "b", "c"], 2, BigInt(7)); // 7 % 3 = 1
    expect(batch).toEqual(["b", "c"]);
  });

  it("single-element list always returns that one element regardless of offset", () => {
    for (const offset of [BigInt(0), BigInt(1), BigInt(5), BigInt(100)]) {
      const { batch } = selectReorgRecheckBatch(["only"], 3, offset);
      expect(batch).toEqual(["only"]);
    }
  });
});
