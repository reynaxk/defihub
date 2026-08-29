import { eq } from "drizzle-orm";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { db } from "@/lib/database/client";
import { chains, protocols } from "@/lib/database/schema";
import { scanFromCursor } from "@/lib/indexing/events";
import { logger } from "@/lib/observability/logger";
import { FACTORY_DEPLOYMENTS, type FactoryDeployment } from "./config";
import { getPendingDiscoveredPools, markDiscoveredPoolActive, markDiscoveredPoolRejected, recordDiscoveredPools } from "./queries";
import { registerDiscoveredPoolAsPool } from "./register";
import { decodePairCreatedLog, PAIR_CREATED_EVENT_SIGNATURE } from "./scan";
import { validateDiscoveredPool } from "./validate";

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
}

async function scanForNewPools(deployment: FactoryDeployment, chainId: string): Promise<{ discovered: number; scanOutcome: "success" | "partial"; chunksCompleted: number }> {
  const component = `discovery:${deployment.key}`;
  let discoveredCount = 0;

  const currentBlock = await withResilientClient(deployment.chainSlug, (client) => client.getBlockNumber());

  const scanResult = await scanFromCursor({
    chainSlug: deployment.chainSlug,
    component,
    address: deployment.factoryAddress as `0x${string}`,
    eventSignature: PAIR_CREATED_EVENT_SIGNATURE,
    currentBlock,
    startBlock: deployment.startBlock,
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

  for (const row of pending) {
    let outcome;
    try {
      outcome = await validateDiscoveredPool(deployment, {
        token0: row.token0Address,
        token1: row.token1Address,
        poolAddress: row.poolAddress,
        blockNumber: BigInt(row.creationBlockNumber),
        blockHash: row.creationBlockHash,
        transactionHash: row.creationTransactionHash,
        logIndex: row.creationLogIndex,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("pool discovery: validation read failed - leaving pending for retry", { component: "onchain-discovery", deployment: deployment.key, pool: row.poolAddress, error: message });
      continue; // left in "discovered" status - retried next run, never rejected merely because this run's RPC read failed
    }

    if (!outcome.accepted) {
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

export async function discoverPoolsForDeployment(deployment: FactoryDeployment): Promise<DiscoveryRunResult> {
  const [chainRow] = await db.select({ id: chains.id }).from(chains).where(eq(chains.slug, deployment.chainSlug));
  if (!chainRow) {
    return { deploymentKey: deployment.key, ok: false, error: `chain "${deployment.chainSlug}" not found in DB`, discovered: 0, validated: 0, activated: 0, rejected: 0 };
  }
  const [protocolRow] = await db.select({ id: protocols.id }).from(protocols).where(eq(protocols.defillamaSlug, deployment.protocolDefillamaSlug));
  const protocolId = protocolRow?.id ?? null;

  try {
    const scan = await scanForNewPools(deployment, chainRow.id);
    const validation = await validatePendingPools(deployment, chainRow.id, protocolId);

    return {
      deploymentKey: deployment.key,
      ok: true,
      discovered: scan.discovered,
      validated: validation.validated,
      activated: validation.activated,
      rejected: validation.rejected,
      scanOutcome: scan.scanOutcome,
      chunksCompleted: scan.chunksCompleted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { deploymentKey: deployment.key, ok: false, error: message, discovered: 0, validated: 0, activated: 0, rejected: 0 };
  }
}

// Every configured factory deployment, one at a time, each with its own
// try/catch (already inside discoverPoolsForDeployment) so one
// deployment's failure never stops the rest - the same failure-isolation
// discipline indexAllPoolVolume already established.
export async function discoverAllPools(deployments: FactoryDeployment[] = FACTORY_DEPLOYMENTS): Promise<DiscoveryRunResult[]> {
  const results: DiscoveryRunResult[] = [];
  for (const deployment of deployments) {
    results.push(await discoverPoolsForDeployment(deployment));
  }
  return results;
}
