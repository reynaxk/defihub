import { withResilientClient } from "@/lib/chains/rpc-resilient-client";

export type ReorgCheckStatus = "confirmed" | "reorged" | "unknown";

export interface ReorgCheckResult {
  status: ReorgCheckStatus;
  currentBlockHash: string | null;
}

// Compares a historical observation's pinned block hash against what that
// same block number resolves to right now. `readBlockHash` is injected
// (see readBlockHashOnChain below for the real implementation) so this
// stays unit-testable without a live RPC call.
//
// Deliberately three-valued, not a boolean: a transient failure to read
// the current hash (RPC down, block pruned by the provider, etc.) must
// never be reported as proof the chain reorged - "reorged" is reserved for
// a genuine hash mismatch, and "unknown" covers everything that couldn't
// actually be determined. Never fabricate a verdict from a failed read.
export async function checkBlockHashStillCanonical(
  blockNumber: bigint,
  expectedBlockHash: string,
  readBlockHash: (blockNumber: bigint) => Promise<string | null>,
): Promise<ReorgCheckResult> {
  let currentBlockHash: string | null;
  try {
    currentBlockHash = await readBlockHash(blockNumber);
  } catch {
    return { status: "unknown", currentBlockHash: null };
  }

  if (currentBlockHash == null) return { status: "unknown", currentBlockHash: null };

  return {
    status: currentBlockHash.toLowerCase() === expectedBlockHash.toLowerCase() ? "confirmed" : "reorged",
    currentBlockHash,
  };
}

// The real block-hash reader, for production use - reads through the same
// resilient/failover RPC wrapper every other on-chain read in this app
// uses. Not wired into the verification cron itself yet (out of scope for
// this change - see docs/native-data.md); exported so a future scheduled
// check or manual re-verification can use it without re-deriving this.
export async function readBlockHashOnChain(chainSlug: string, blockNumber: bigint): Promise<string | null> {
  const block = await withResilientClient(chainSlug, (client) => client.getBlock({ blockNumber }));
  return block.hash ?? null;
}
