import { eq } from "drizzle-orm";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { db } from "@/lib/database/client";
import { chains, protocols } from "@/lib/database/schema";
import { scanFromCursor } from "@/lib/indexing/events";
import { logger } from "@/lib/observability/logger";
import type { ReorgCheckResult } from "@/lib/onchain/reorg";
import { effectiveStartBlock } from "@/lib/onchain/volume/engine";
import { FACTORY_DEPLOYMENTS, type FactoryDeployment } from "./config";
import { getPendingDiscoveredPools, markDiscoveredPoolActive, markDiscoveredPoolRejected, recordDiscoveredPools } from "./queries";
import { registerDiscoveredPoolAsPool } from "./register";
import { decodePairCreatedLog, PAIR_CREATED_EVENT_SIGNATURE } from "./scan";
import { validateDiscoveredPoolsBatch } from "./validate";

// Section 5's bounded discovery primitive: reuses scanFromCursor
// (lib/indexing/events.ts) exactly as engine.ts (volume) does - the same
// chunked/checkpointed/resilient/reorg-aware scan, a distinct
// `discovery:${deployment.key}` indexing_state component so this cursor
// never collides with a volume-indexing one for the same chain. Not a
// second generic RPC scanner - the identical primitive, a different event
// signature and a different persistence target (discovered_pools instead
// of swap_events).
const DISCOVERY_CHUNK_SIZE = BigInt(50);

// Section 16's simplest safe prioritization: process at most this many
// newly-discovered candidates per run. Discovery on a factory this active
// (PancakeSwap V2 alone produced 422 real PairCreated events in one
// ~2,000-block window during this phase's own live verification) could
// otherwise mean one run's validation pass tries to make an unbounded
// number of RPC calls. No liquidity/activity-based ranking is implemented
// - Section 16 explicitly permits skipping prioritization when the
// workload doesn't need it, and a flat FIFO batch (oldest-discovered-first,
// via the underlying query's natural insertion order) already guarantees
// every candidate eventually gets validated across enough runs, with
// nothing invented about which pools matter more than others.
const VALIDATION_BATCH_SIZE = 25;

export interface DiscoveryRunResult {
  deploymentKey: string;
  ok: boolean;
  error?: string;
  discovered: number;
  validated: number;
  activated: number;
  rejected: number;
  scanOutcome?: "success" | "partial";
  chunksCompleted?: number;
  // Phase 5.10 fix: set when the SCAN phase itself failed (e.g. an
  // eth_getLogs-specific RPC policy rejection) but validation still ran
  // independently against whatever candidates already existed in
  // `discovered_pools` - see discoverPoolsForDeployment's own comment for
  // why these two phases are no longer coupled. `ok` can be true with this
  // set (validation made real progress despite the scan failure); never
  // silently dropped even when ok is true, so a scan-side failure stays
  // visible instead of vanishing the moment validation happens to succeed.
  scanError?: string;
}

async function scanForNewPools(deployment: FactoryDeployment, chainId: string): Promise<{ discovered: number; scanOutcome: "success" | "partial"; chunksCompleted: number }> {
  const component = `discovery:${deployment.key}`;
  let discoveredCount = 0;

  const currentBlock = await withResilientClient(deployment.chainSlug, (client) => client.getBlockNumber());
  // Reuses volume/engine.ts's own effectiveStartBlock unmodified - the
  // identical "never further back than this provider's live-servable
  // window" correction VolumeSourcePool.startBlock already needed
  // (see that function's own comment). FactoryDeployment.startBlock is
  // exactly as vulnerable to going stale as a config-curated pool's own
  // startBlock is - a value that was a safe recent floor at config-
  // authoring time becomes unreachable the moment real time moves the
  // chain head far enough past it, which happens routinely (and is
  // exactly what this app's own free RPC tier already hit for volume
  // indexing multiple times across earlier phases) - only mattering on a
  // genuinely first-ever scan for this deployment (scanFromCursor only
  // consults startBlock when no cursor is persisted yet), but that first
  // scan must not be a guaranteed, permanent range-limit failure the
  // moment a NEW deployment is added or a fresh environment starts from
  // an empty indexing_state table.
  const { startBlock: effectiveStart, skippedBlocks } = effectiveStartBlock(deployment, currentBlock);
  if (skippedBlocks > BigInt(0)) {
    logger.warn("pool discovery: configured startBlock is stale relative to the confirmed chain head - skipping ahead to a range this RPC provider can actually serve", {
      component: "onchain-discovery",
      deployment: deployment.key,
      configuredStartBlock: deployment.startBlock.toString(),
      effectiveStartBlock: effectiveStart.toString(),
      skippedBlocks: skippedBlocks.toString(),
    });
  }

  const scanResult = await scanFromCursor({
    chainSlug: deployment.chainSlug,
    component,
    address: deployment.factoryAddress as `0x${string}`,
    eventSignature: PAIR_CREATED_EVENT_SIGNATURE,
    currentBlock,
    startBlock: effectiveStart,
    chunkSize: DISCOVERY_CHUNK_SIZE,
    confirmations: confirmationsFor(deployment.chainSlug),
    onLogs: async (logs) => {
      const decoded = [];
      let malformedCount = 0;
      for (const log of logs) {
        const candidate = decodePairCreatedLog(log);
        if (!candidate) {
          malformedCount++;
          continue;
        }
        decoded.push(candidate);
      }
      if (malformedCount > 0) {
        logger.warn("pool discovery: skipped malformed PairCreated log(s)", { component: "onchain-discovery", deployment: deployment.key, malformedCount });
      }

      const inserted = await recordDiscoveredPools(chainId, deployment, decoded);
      discoveredCount += inserted;
    },
  });

  return { discovered: discoveredCount, scanOutcome: scanResult.outcome, chunksCompleted: scanResult.chunksCompleted };
}

async function validatePendingPools(deployment: FactoryDeployment, chainId: string, protocolId: string | null): Promise<{ validated: number; activated: number; rejected: number }> {
  const pending = await getPendingDiscoveredPools(deployment.key, VALIDATION_BATCH_SIZE);
  let activated = 0;
  let rejected = 0;
  if (pending.length === 0) return { validated: 0, activated: 0, rejected: 0 };

  // Shared across every candidate in THIS page, never across separate
  // validatePendingPools calls (deliberately created fresh here, per run -
  // a stale canonical-block verdict from a much earlier run must never be
  // reused) - see validateDiscoveredPoolsBatch's own comment for exactly
  // what this dedupes and why.
  const canonicalCheckCache: Map<string, Promise<ReorgCheckResult>> = new Map();

  // ONE multicall covering the WHOLE page, not one per candidate - see
  // validateDiscoveredPoolsBatch's own module comment for exactly why this
  // matters at scale (VALIDATION_BATCH_SIZE candidates each paying their
  // own RPC round-trip latency, sequentially, adds up fast once the
  // pending backlog is routinely full). A whole-batch RPC failure here
  // resolves to "retry" for every candidate (never thrown) - see that
  // function's own contract - so this call itself is not expected to
  // reject under normal operation; letting a genuinely unexpected throw
  // propagate to discoverPoolsForDeployment's own catch is intentional,
  // not an oversight.
  const outcomes = await validateDiscoveredPoolsBatch(
    deployment,
    pending.map((row) => ({
      token0: row.token0Address,
      token1: row.token1Address,
      poolAddress: row.poolAddress,
      blockNumber: BigInt(row.creationBlockNumber),
      blockHash: row.creationBlockHash,
      transactionHash: row.creationTransactionHash,
      logIndex: row.creationLogIndex,
    })),
    undefined,
    canonicalCheckCache,
  );

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const outcome = outcomes[i];

    if (outcome.status === "retry") {
      // Transient (an unresolvable canonical-block check or a whole-batch
      // RPC failure inside validateDiscoveredPool itself) - the row is
      // left completely untouched in "discovered" status, tried again
      // next run. Never persisted as "rejected": that status is reserved
      // for a genuinely, deterministically invalid candidate (see the
      // "rejected" branch below) - conflating the two would permanently
      // blacklist a real, valid pool over nothing more than a passing RPC
      // hiccup.
      logger.warn("pool discovery: validation could not be completed this run - leaving pending for retry", {
        component: "onchain-discovery",
        deployment: deployment.key,
        pool: row.poolAddress,
        reason: outcome.reason,
      });
      continue;
    }

    if (outcome.status === "rejected") {
      await markDiscoveredPoolRejected(row.id, outcome.reason);
      rejected++;
      logger.info("pool discovery: candidate rejected", { component: "onchain-discovery", deployment: deployment.key, pool: row.poolAddress, reason: outcome.reason });
      continue;
    }

    try {
      // Symbols are best-effort only (validate.ts's own multicall comment)
      // - never blocks acceptance; a missing/malformed symbol() just means
      // the pool's label falls back to a truncated address, the same
      // "unknown, never guessed" convention pool_tokens.symbol already
      // tolerates elsewhere in this table when a real value can't be
      // resolved.
      const poolId = await registerDiscoveredPoolAsPool(
        chainId,
        protocolId,
        deployment,
        row.poolAddress,
        { address: row.token0Address, symbol: outcome.token0Symbol, decimals: outcome.token0Decimals },
        { address: row.token1Address, symbol: outcome.token1Symbol, decimals: outcome.token1Decimals },
      );
      await markDiscoveredPoolActive(row.id, outcome.token0Decimals, outcome.token1Decimals, poolId, outcome.token0Symbol, outcome.token1Symbol);
      activated++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("pool discovery: registration failed after successful validation - leaving pending for retry", {
        component: "onchain-discovery",
        deployment: deployment.key,
        pool: row.poolAddress,
        error: message,
      });
    }
  }

  return { validated: activated + rejected, activated, rejected };
}

// Phase 5.10 fix: scan (eth_getLogs, finding NEW candidates) and validation
// (eth_call/multicall, deciding on candidates ALREADY sitting in
// `discovered_pools`) are genuinely independent RPC operations against
// genuinely independent chain data - the only thing they share is a
// deployment and a chain. Before this fix they were coupled inside one
// try/catch: a scan failure (a "discovered" candidate range unreachable
// through this provider, a factory-specific RPC error) short-circuited the
// WHOLE call and skipped validation entirely, even though validation
// doesn't touch eth_getLogs at all and had a completely independent chance
// of succeeding against whatever candidates already existed. Live-observed
// real bug: a public RPC provider policy change (this provider now
// requires a personal archive token for every eth_getLogs call,
// discovered live during this phase's own development) made scanning
// fail 100% of the time for both configured deployments, which silently
// blocked 28 already-discovered, already-real candidates from EVER being
// validated - real pending work stuck behind an unrelated failure, exactly
// the kind of avoidable cross-phase coupling Section 27's "failure
// isolation" exists to prevent. Each phase now runs in its own try/catch;
// a scan failure is recorded (scanError) but never prevents validation
// from running, and vice versa.
export async function discoverPoolsForDeployment(deployment: FactoryDeployment): Promise<DiscoveryRunResult> {
  const [chainRow] = await db.select({ id: chains.id }).from(chains).where(eq(chains.slug, deployment.chainSlug));
  if (!chainRow) {
    return { deploymentKey: deployment.key, ok: false, error: `chain "${deployment.chainSlug}" not found in DB`, discovered: 0, validated: 0, activated: 0, rejected: 0 };
  }
  const [protocolRow] = await db.select({ id: protocols.id }).from(protocols).where(eq(protocols.defillamaSlug, deployment.protocolDefillamaSlug));
  const protocolId = protocolRow?.id ?? null;

  let discovered = 0;
  let scanOutcome: "success" | "partial" | undefined;
  let chunksCompleted: number | undefined;
  let scanError: string | undefined;
  try {
    const scan = await scanForNewPools(deployment, chainRow.id);
    discovered = scan.discovered;
    scanOutcome = scan.scanOutcome;
    chunksCompleted = scan.chunksCompleted;
  } catch (err) {
    scanError = err instanceof Error ? err.message : String(err);
    logger.warn("pool discovery: scan failed for this deployment - validation still runs independently against any already-discovered candidates", {
      component: "onchain-discovery",
      deployment: deployment.key,
      error: scanError,
    });
  }

  try {
    const validation = await validatePendingPools(deployment, chainRow.id, protocolId);
    return {
      deploymentKey: deployment.key,
      ok: true,
      discovered,
      validated: validation.validated,
      activated: validation.activated,
      rejected: validation.rejected,
      scanOutcome,
      chunksCompleted,
      ...(scanError ? { scanError } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      deploymentKey: deployment.key,
      // Genuinely ok only if the scan phase itself succeeded - both
      // phases failing is this deployment's own total failure this run,
      // matching the pre-fix contract for the case where nothing here has
      // changed (a working scan, a broken validation).
      ok: scanError == null,
      error: scanError ? `scan: ${scanError}; validation: ${message}` : message,
      discovered,
      validated: 0,
      activated: 0,
      rejected: 0,
      scanOutcome,
      chunksCompleted,
    };
  }
}

// Every configured factory deployment, one at a time, each with its own
// try/catch (already inside discoverPoolsForDeployment) so one
// deployment's failure never stops the rest - the same failure-isolation
// discipline indexAllPoolVolume already established.
export async function discoverAllPools(deployments: readonly FactoryDeployment[] = FACTORY_DEPLOYMENTS): Promise<DiscoveryRunResult[]> {
  const results: DiscoveryRunResult[] = [];
  for (const deployment of deployments) {
    results.push(await discoverPoolsForDeployment(deployment));
  }
  return results;
}
