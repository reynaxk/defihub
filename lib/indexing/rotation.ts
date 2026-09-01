// A generic round-robin batch-selection primitive, shared by every job in
// this app that must guarantee fairness across a growing list of entities
// under a bounded per-run budget - originally built for
// lib/onchain/volume/reorg.ts's pool-recheck rotation (CodeRabbit PR #17
// fix: a fixed `.slice(0, batchSize)` meant pools past the first
// `batchSize` never got rechecked again once the pool count grew past
// that size), then reused as-is by lib/onchain/volume/engine.ts's
// indexAllPoolVolume (Phase 5.10 fix - see that module's own comment for
// the live-reproduced starvation this closes at the volume-indexing
// scale).
//
// Pure, directly testable with a plain array + offset, no RPC/DB. Returns
// up to `batchSize` items starting at `offset % items.length` and wrapping
// around the end of the list back to the start - across enough successive
// calls (each one's own `nextOffset` fed back in as the next call's
// `offset`), every item in the list eventually gets included, not just
// whichever ones happen to sit in the first `batchSize` array slots.
//
// The persisted offset this returns is deliberately an ever-INCREASING
// total-items-advanced counter, never the wrapped array index itself -
// callers typically persist it via indexing_state's own
// GREATEST()-protected atomic upsert (lib/indexing/state.ts), which
// enforces "never move backward." That's exactly wrong for a WRAPPING
// rotation offset (it would get permanently stuck at the highest offset
// ever reached, never cycling back to the start) - the actual index used
// each call is `offset % items.length`, recomputed fresh every time from
// whatever the CURRENT item count is, so this stays correct even when
// items are added/removed between calls, with zero changes needed to that
// shared cursor primitive.
export interface RotatingBatchSelection<T> {
  batch: T[];
  nextOffset: bigint;
}

export function selectRotatingBatch<T>(items: readonly T[], batchSize: number, offset: bigint): RotatingBatchSelection<T> {
  if (items.length === 0 || batchSize <= 0) return { batch: [], nextOffset: offset };

  const len = BigInt(items.length);
  const start = ((offset % len) + len) % len; // defensively normalizes a negative/out-of-range offset, though one should never actually occur
  const n = BigInt(Math.min(batchSize, items.length));

  const batch: T[] = [];
  for (let i = BigInt(0); i < n; i++) {
    batch.push(items[Number((start + i) % len)]);
  }

  return { batch, nextOffset: offset + n };
}
