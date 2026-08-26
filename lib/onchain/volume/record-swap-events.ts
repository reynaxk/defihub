import { db } from "@/lib/database/client";
import { swapEvents } from "@/lib/database/schema";
import type { DecodedSwapEvent } from "./types";

export interface SwapEventRecord {
  chainId: string;
  poolId: string;
  sourceKind: string;
  event: DecodedSwapEvent;
}

// Idempotent batch insert - onConflictDoNothing targets
// swap_events_pool_tx_log_unique (schema.ts), the exact identity a
// re-processed block range's events must collide against: the same real
// on-chain event, re-decoded from a re-scanned range, is silently a no-op
// here rather than a duplicate row. One statement for the whole batch
// (never one INSERT per event - Section 28's own "avoid one DB write per
// event" instruction), and safe to call with an empty array. Returns the
// count actually written (a repeat call for an already-indexed range
// returns 0, not the batch size) so callers can tell a genuine no-op run
// apart from one that inserted nothing because the range itself was empty.
export async function recordSwapEvents(records: SwapEventRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const rows = await db
    .insert(swapEvents)
    .values(
      records.map((r) => ({
        chainId: r.chainId,
        poolId: r.poolId,
        sourceKind: r.sourceKind,
        transactionHash: r.event.transactionHash,
        logIndex: r.event.logIndex,
        blockNumber: r.event.blockNumber.toString(),
        blockHash: r.event.blockHash,
        blockTimestamp: r.event.blockTimestamp,
        sender: r.event.sender,
        amount0In: r.event.amount0In.toString(),
        amount1In: r.event.amount1In.toString(),
        amount0Out: r.event.amount0Out.toString(),
        amount1Out: r.event.amount1Out.toString(),
      })),
    )
    .onConflictDoNothing({
      target: [swapEvents.poolId, swapEvents.transactionHash, swapEvents.logIndex],
    })
    .returning({ id: swapEvents.id });

  return rows.length;
}
