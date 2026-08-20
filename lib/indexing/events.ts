import { parseAbiItem, type Address, type Log } from "viem";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { getIndexingState, updateIndexingState } from "./state";

// Reusable primitives for future incremental event-log ingestion -
// foundation only, not a shipped indexer. See workers/onchain/scan-events-
// example.ts for the one concrete, deliberately small proof this works
// end-to-end.

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
// just that chunk rather than restarting the whole range.
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
  chunkSize?: bigint;
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
  // Called once with every log this run found, before the cursor advances
  // - must be idempotent (e.g. upsert keyed by (transactionHash,
  // logIndex)), since a crash between onLogs succeeding and the cursor
  // write below would otherwise reprocess the same range next run.
  onLogs: (logs: Log[]) => Promise<void>;
}

export interface ScanResult {
  scannedFrom: bigint;
  scannedTo: bigint;
  logCount: number;
}

// Resumes from the persisted cursor (lastProcessedBlock + 1) or
// startBlock on a first run, scans up to currentBlock, calls onLogs, then
// advances the cursor - restart-safe because the cursor is only ever
// advanced after onLogs completes successfully, so a crash mid-run simply
// means the next invocation resumes from the last successfully-processed
// block instead of skipping or silently losing a range.
export async function scanFromCursor(params: ScanFromCursorParams): Promise<ScanResult> {
  const {
    chainSlug,
    component,
    address,
    eventSignature,
    currentBlock,
    startBlock,
    chunkSize,
    confirmations = BigInt(0),
    onLogs,
  } = params;
  // Never scan to (or persist a cursor at) the unconfirmed tip - see
  // `confirmations` above.
  const safeToBlock = currentBlock > confirmations ? currentBlock - confirmations : BigInt(0);

  await updateIndexingState(chainSlug, component, { status: "running", lastAttemptedSyncAt: new Date() });

  try {
    const state = await getIndexingState(chainSlug, component);
    const fromBlock = state?.lastProcessedBlock != null ? state.lastProcessedBlock + BigInt(1) : startBlock;

    if (fromBlock > safeToBlock) {
      await updateIndexingState(chainSlug, component, { status: "idle", lastSuccessfulSyncAt: new Date() });
      return { scannedFrom: fromBlock, scannedTo: fromBlock - BigInt(1), logCount: 0 };
    }

    const logs = await scanBlockRange({ chainSlug, address, eventSignature, fromBlock, toBlock: safeToBlock, chunkSize });
    await onLogs(logs);

    await updateIndexingState(chainSlug, component, {
      status: "idle",
      lastProcessedBlock: safeToBlock,
      lastSuccessfulSyncAt: new Date(),
    });

    return { scannedFrom: fromBlock, scannedTo: safeToBlock, logCount: logs.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateIndexingState(chainSlug, component, { status: "error", error: message });
    throw err;
  }
}
