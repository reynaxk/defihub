import { getIndexingState, updateIndexingState } from "./state";

// Section 35's operator-only recovery mechanism - the one explicitly
// sanctioned way to unstick a cursor that has fallen PERMANENTLY behind a
// free-tier RPC provider's servable window, where scanFromCursor's own
// adaptive shrinking (lib/indexing/events.ts) has already been tried and
// still range-limits even at the minimum chunk size (Section 8's own
// "otherwise stop without advancing the cursor - do NOT silently skip
// blocks" default is the correct AUTOMATED behavior, but it leaves a
// genuinely stuck cursor stuck forever with no automated way out - this is
// that way out, deliberately manual and deliberately loud about the skip
// it performs).
//
// This is NOT a routine tool. Calling it means accepting that the blocks
// between the old cursor and `toBlock` are never going to be indexed - any
// swap events in that range are permanently missing from swap_events, and
// any aggregate observation that would have covered them never exists.
// That gap is exactly as real and exactly as risky as it sounds, which is
// why this function:
//   - requires an explicit, non-empty `reason` (never silently invoked)
//   - refuses to move the cursor backward or sideways (Invariant 3 still
//     applies to a manual advance, not just an automated one)
//   - records the reason AND the exact skipped range directly into
//     indexing_state.error, so it stays visible to every future
//     getIndexingState read and to /api/cron/health's own sync-status
//     surface - never a quiet, undocumented jump.
//
// Never wired to any cron schedule or public API route (Section 35/45's
// "do not expose arbitrary block scanning to public users") - the only
// caller is workers/onchain/volume-recover.ts, a manually-invoked CLI
// script requiring direct server/deploy access to the same DATABASE_URL
// every other worker in this app already needs.
export interface ManualCursorAdvanceResult {
  previousCursor: bigint | null;
  newCursor: bigint;
}

export async function manuallyAdvanceCursor(
  chainSlug: string,
  component: string,
  toBlock: bigint,
  reason: string,
): Promise<ManualCursorAdvanceResult> {
  if (!reason.trim()) {
    throw new Error("manuallyAdvanceCursor: a non-empty reason is required - this operation permanently skips block data");
  }

  const before = await getIndexingState(chainSlug, component);
  const previousCursor = before?.lastProcessedBlock ?? null;

  if (previousCursor != null && previousCursor >= toBlock) {
    throw new Error(
      `manuallyAdvanceCursor: refusing to move the cursor backward or sideways (current ${previousCursor.toString()}, requested ${toBlock.toString()})`,
    );
  }

  const skippedFrom = previousCursor != null ? previousCursor + BigInt(1) : BigInt(0);
  await updateIndexingState(chainSlug, component, {
    status: "idle",
    lastProcessedBlock: toBlock,
    lastSuccessfulSyncAt: new Date(),
    error: `manually advanced by operator: ${reason} (skipped blocks ${skippedFrom.toString()}-${toBlock.toString()})`,
  });

  return { previousCursor, newCursor: toBlock };
}
