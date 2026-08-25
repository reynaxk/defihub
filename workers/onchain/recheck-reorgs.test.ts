// Real-Postgres integration tests, same reasoning as
// workers/retention/rollup.test.ts and lib/onchain/pools.test.ts: the
// idempotent-cursor and advisory-lock behavior under test is the actual
// thing being verified, not mockable. Every test creates its own chain +
// pool row (via poolEntitiesOverride, mirroring syncPoolsFromConfig's own
// test-only `poolsToSync` override) and only asserts on rows scoped to
// those ids, so this is safe to run regardless of whatever else already
// exists in the database - including the real VERIFIED_POOLS-derived rows
// this job operates on in production.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, indexingState, pools } from "@/lib/database/schema";
import { REORG_RECHECK_ADVISORY_LOCK_KEY, recheckPoolTvlReorgs } from "./recheck-reorgs";

const REAL_HASH_A = `0x${"a".repeat(64)}`;
const REAL_HASH_B = `0x${"b".repeat(64)}`;
const REAL_HASH_C = `0x${"c".repeat(64)}`;
const REAL_HASH_D = `0x${"d".repeat(64)}`;

async function makeChain() {
  const slug = `test-recheck-chain-${randomUUID()}`;
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test Recheck Chain ${randomUUID()}`, slug, nativeToken: "TST" })
    .returning({ id: chains.id, slug: chains.slug });
  return chain;
}

async function makePool(chainId: string) {
  const configKey = `test-recheck-pool-${randomUUID()}`;
  const [pool] = await db
    .insert(pools)
    .values({ configKey, chainId, label: "Test recheck pool", address: `0xpool${randomUUID().slice(0, 8)}` })
    .returning({ id: pools.id, configKey: pools.configKey });
  return pool;
}

async function makeObservation(poolId: string, chainId: string, blockNumber: bigint, blockHash: string) {
  const [row] = await db
    .insert(historicalObservations)
    .values({
      chainId,
      entityType: "pool",
      entityId: poolId,
      metric: "tvl_usd",
      value: "100.00000000",
      timestamp: new Date(),
      blockNumber: blockNumber.toString(),
      blockHash,
      source: "test",
    })
    .returning({ id: historicalObservations.id });
  return row.id;
}

async function getState(chainSlug: string, configKey: string) {
  const [state] = await db
    .select()
    .from(indexingState)
    .where(and(eq(indexingState.chainSlug, chainSlug), eq(indexingState.component, `reorg-recheck:pool:${configKey}`)));
  return state;
}

describe("recheckPoolTvlReorgs", () => {
  const createdChainIds: string[] = [];
  const createdPoolIds: string[] = [];

  afterEach(async () => {
    // historical_observations.entityId and indexing_state.chainSlug are
    // plain columns, not FKs (see historicalObservations' own schema
    // comment on why entityType/entityId is deliberately not a real FK) -
    // deleting the chain (which cascades to `pools`) does NOT clean these
    // up, so both need explicit cleanup here.
    if (createdPoolIds.length > 0) {
      await db.delete(historicalObservations).where(inArray(historicalObservations.entityId, createdPoolIds));
    }
    for (const chainId of createdChainIds) {
      const [chain] = await db.select({ slug: chains.slug }).from(chains).where(eq(chains.id, chainId));
      if (chain) await db.delete(indexingState).where(eq(indexingState.chainSlug, chain.slug));
    }
    createdPoolIds.splice(0);
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reports confirmed, advances the cursor, and records a successful sync timestamp when the stored hash still matches the canonical chain", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(100), REAL_HASH_A);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats).not.toBeNull();
    expect(stats!.totalConfirmed).toBe(1);
    expect(stats!.totalReorged).toBe(0);
    expect(stats!.totalUnknown).toBe(0);
    expect(stats!.entitiesFailed).toBe(0);
    expect(stats!.entitiesProcessed).toBe(1);

    const state = await getState(chain.slug, pool.configKey);
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
    expect(Number(state.lastProcessedBlock)).toBe(100);
    // A genuinely, fully successful run must record its completion.
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("detects a reorg, identifies the affected observation, and does not record a successful sync timestamp", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    const obsId = await makeObservation(pool.id, chain.id, BigInt(200), REAL_HASH_A);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_B, // chain now resolves block 200 to a different hash
    });

    expect(stats!.totalReorged).toBe(1);
    expect(stats!.totalConfirmed).toBe(0);
    expect(stats!.perEntity[0].reorgedObservations).toEqual([
      { observationId: obsId, blockNumber: "200", storedBlockHash: REAL_HASH_A, currentBlockHash: REAL_HASH_B },
    ]);

    // The observation itself is never mutated or deleted - provenance is
    // preserved exactly as recorded, per the task's own instruction not to
    // invent a destructive reconciliation behavior.
    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsId));
    expect(row.blockHash).toBe(REAL_HASH_A);

    const state = await getState(chain.slug, pool.configKey);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/reorg detected/);
    // A detected reorg is still a *resolved* check (we now know the answer)
    // - the cursor advances past it so the same block isn't re-flagged
    // forever with no new information; the durable record of the finding
    // lives in this run's sync_runs row and structured logs instead.
    expect(Number(state.lastProcessedBlock)).toBe(200);
    // But it is NOT a successful sync - a reorg means this run surfaced a
    // real problem, and must never be recorded as if everything checked out.
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  it("treats an RPC failure (thrown error) as unknown - never confirmed or reorged - advances no cursor, and records no successful sync timestamp", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(300), REAL_HASH_A);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => {
        throw new Error("simulated RPC timeout");
      },
    });

    expect(stats!.totalUnknown).toBe(1);
    expect(stats!.totalConfirmed).toBe(0);
    expect(stats!.totalReorged).toBe(0);

    const state = await getState(chain.slug, pool.configKey);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/RPC read failed/);
    // Never advanced - an inconclusive read must be retried, not accepted.
    expect(state.lastProcessedBlock).toBeNull();
    // Not a successful sync - the run could not confirm anything.
    expect(state.lastSuccessfulSyncAt).toBeNull();

    // A later run, once the RPC read succeeds, picks the exact same
    // observation back up (the cursor never moved past it) instead of
    // silently losing track of it.
    const retry = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });
    expect(retry!.totalConfirmed).toBe(1);
    const retryState = await getState(chain.slug, pool.configKey);
    expect(retryState.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("treats an inconclusive read (reader returns null, no throw) the same as a failure - unknown, no cursor advance, no successful sync timestamp", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(350), REAL_HASH_A);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => null,
    });

    expect(stats!.totalUnknown).toBe(1);
    expect(stats!.totalConfirmed).toBe(0);
    expect(stats!.totalReorged).toBe(0);

    const state = await getState(chain.slug, pool.configKey);
    expect(state.status).toBe("error");
    expect(state.lastProcessedBlock).toBeNull();
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  it("is idempotent - running the same recheck twice creates no duplicate observations or checkpoint rows", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(400), REAL_HASH_A);

    const entity = { poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug };
    const first = await recheckPoolTvlReorgs({ poolEntitiesOverride: [entity], readBlockHash: async () => REAL_HASH_A });
    expect(first!.totalConfirmed).toBe(1);

    const second = await recheckPoolTvlReorgs({ poolEntitiesOverride: [entity], readBlockHash: async () => REAL_HASH_A });
    // Nothing new to check - the cursor already covers this observation.
    expect(second!.entitiesProcessed).toBe(0);
    expect(second!.totalChecked).toBe(0);

    const observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, pool.id));
    expect(observations).toHaveLength(1);

    const stateRows = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, chain.slug), eq(indexingState.component, `reorg-recheck:pool:${pool.configKey}`)));
    expect(stateRows).toHaveLength(1);
  });

  it("checks every observation sharing a block number - a shared block number never lets a sibling with a different hash be skipped", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    // Two observations at the SAME block number with different hashes -
    // the reorg-aware identity model deliberately allows this (same block
    // number, different chain history). lookbackDepth is deliberately 1:
    // under the old row-level LIMIT, this would have fetched only one of
    // the two siblings and then advanced the cursor past block 500,
    // permanently stranding the other - the fixed, block-number-bounded
    // query must still return both.
    const obsA = await makeObservation(pool.id, chain.id, BigInt(500), REAL_HASH_A);
    const obsB = await makeObservation(pool.id, chain.id, BigInt(500), REAL_HASH_B);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      lookbackDepth: 1,
      readBlockHash: async () => REAL_HASH_A, // matches obsA only - obsB's stored hash is now stale
    });

    expect(stats!.totalChecked).toBe(2);
    expect(stats!.totalConfirmed).toBe(1);
    expect(stats!.totalReorged).toBe(1);
    expect(stats!.perEntity[0].reorgedObservations.map((o) => o.observationId)).toEqual([obsB]);
    expect(obsA).not.toBe(obsB);

    const state = await getState(chain.slug, pool.configKey);
    // Both siblings resolved (one confirmed, one reorged - neither
    // unknown), so the whole block-500 group is fully resolved and the
    // cursor safely advances past it.
    expect(Number(state.lastProcessedBlock)).toBe(500);
  });

  it("respects the configured lookback depth using actual numeric block ordering, then picks up nothing further on a later run", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(9), REAL_HASH_A);
    await makeObservation(pool.id, chain.id, BigInt(10), REAL_HASH_B);
    await makeObservation(pool.id, chain.id, BigInt(100), REAL_HASH_C);
    await makeObservation(pool.id, chain.id, BigInt(1000), REAL_HASH_D);

    const hashByBlock: Record<number, string> = { 9: REAL_HASH_A, 10: REAL_HASH_B, 100: REAL_HASH_C, 1000: REAL_HASH_D };
    const entity = { poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug };

    const first = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [entity],
      lookbackDepth: 2,
      readBlockHash: async (_chain, blockNumber) => hashByBlock[Number(blockNumber)],
    });

    // Cold start with lookbackDepth 2 must select the 2 numerically highest
    // block numbers - 100 and 1000 - not the 2 lexically-last ("9", "10" if
    // ever compared as strings, or ordered by insertion). Only 2 checks
    // means blocks 9 and 10 were excluded; the cursor landing at exactly
    // 1000 (not 10) is what proves numeric, not lexical/insertion, ordering
    // actually selected 100 and 1000.
    expect(first!.totalChecked).toBe(2);
    expect(first!.perEntity[0].confirmed).toBe(2);

    const state = await getState(chain.slug, pool.configKey);
    expect(Number(state.lastProcessedBlock)).toBe(1000);

    // Blocks 9 and 10 predate the cursor now, so a later run never revisits
    // them - lookbackDepth bounds the cold-start window, it doesn't promise
    // eventual full coverage of pre-cursor history.
    const second = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [entity],
      lookbackDepth: 2,
      readBlockHash: async (_chain, blockNumber) => hashByBlock[Number(blockNumber)],
    });
    expect(second!.totalChecked).toBe(0);
  });

  it("respects the configured batch size, leaving entities beyond it untouched for the next run", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const poolA = await makePool(chain.id);
    const poolB = await makePool(chain.id);
    const poolC = await makePool(chain.id);
    createdPoolIds.push(poolA.id, poolB.id, poolC.id);
    await makeObservation(poolA.id, chain.id, BigInt(10), REAL_HASH_A);
    await makeObservation(poolB.id, chain.id, BigInt(20), REAL_HASH_B);
    await makeObservation(poolC.id, chain.id, BigInt(30), REAL_HASH_C);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [
        { poolId: poolA.id, configKey: poolA.configKey, chainSlug: chain.slug },
        { poolId: poolB.id, configKey: poolB.configKey, chainSlug: chain.slug },
        { poolId: poolC.id, configKey: poolC.configKey, chainSlug: chain.slug },
      ],
      batchSize: 1,
      readBlockHash: async () => REAL_HASH_A, // irrelevant which pool - always "confirmed" for whichever gets checked
    });

    expect(stats!.entitiesConsidered).toBe(3);
    expect(stats!.entitiesProcessed).toBe(1);
    expect(stats!.entitiesSkippedBatchLimit).toBe(2);

    // Only the first pool's checkpoint was touched.
    const touchedStates = await db
      .select()
      .from(indexingState)
      .where(
        and(
          eq(indexingState.chainSlug, chain.slug),
          inArray(indexingState.component, [
            `reorg-recheck:pool:${poolA.configKey}`,
            `reorg-recheck:pool:${poolB.configKey}`,
            `reorg-recheck:pool:${poolC.configKey}`,
          ]),
        ),
      );
    expect(touchedStates).toHaveLength(1);
  });

  it("rotates which entity gets processed across repeated runs when batchSize is smaller than the entity count, preventing starvation", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const poolA = await makePool(chain.id);
    const poolB = await makePool(chain.id);
    const poolC = await makePool(chain.id);
    createdPoolIds.push(poolA.id, poolB.id, poolC.id);
    await makeObservation(poolA.id, chain.id, BigInt(10), REAL_HASH_A);
    await makeObservation(poolB.id, chain.id, BigInt(20), REAL_HASH_B);
    await makeObservation(poolC.id, chain.id, BigInt(30), REAL_HASH_C);

    const entities = [
      { poolId: poolA.id, configKey: poolA.configKey, chainSlug: chain.slug },
      { poolId: poolB.id, configKey: poolB.configKey, chainSlug: chain.slug },
      { poolId: poolC.id, configKey: poolC.configKey, chainSlug: chain.slug },
    ];

    const first = await recheckPoolTvlReorgs({ poolEntitiesOverride: entities, batchSize: 1, readBlockHash: async () => REAL_HASH_A });
    expect(first!.entitiesProcessed).toBe(1);
    const firstProcessedKey = first!.perEntity[0].poolKey;

    const second = await recheckPoolTvlReorgs({ poolEntitiesOverride: entities, batchSize: 1, readBlockHash: async () => REAL_HASH_A });
    expect(second!.entitiesProcessed).toBe(1);
    const secondProcessedKey = second!.perEntity[0].poolKey;

    // Least-recently-attempted ordering (persisted in indexingState, read
    // fresh each run) means the entity processed first is no longer the
    // least-recently-attempted on the next run - a fixed leading entity
    // would otherwise starve the other two forever whenever batchSize is
    // smaller than the entity count.
    expect(secondProcessedKey).not.toBe(firstProcessedKey);

    const third = await recheckPoolTvlReorgs({ poolEntitiesOverride: entities, batchSize: 1, readBlockHash: async () => REAL_HASH_A });
    const thirdProcessedKey = third!.perEntity[0].poolKey;
    // By the third run, all three entities have had exactly one attempt
    // each - confirms actual rotation across the full entity set, not just
    // alternation between two of the three.
    expect(new Set([firstProcessedKey, secondProcessedKey, thirdProcessedKey]).size).toBe(3);
  });

  it("continues processing remaining entities when one entity's recheck throws, and records the failure without aborting the run", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const poolA = await makePool(chain.id);
    const poolC = await makePool(chain.id);
    createdPoolIds.push(poolA.id, poolC.id);
    await makeObservation(poolA.id, chain.id, BigInt(10), REAL_HASH_A);
    await makeObservation(poolC.id, chain.id, BigInt(30), REAL_HASH_C);

    const brokenConfigKey = `broken-pool-${randomUUID()}`;
    const entities = [
      { poolId: poolA.id, configKey: poolA.configKey, chainSlug: chain.slug },
      // Not a real UUID - makes getObservationsNeedingRecheck's query
      // throw for this entity alone (a genuine per-entity failure, unlike
      // an RPC "unknown" which checkBlockHashStillCanonical already
      // absorbs without ever throwing - see the "inconclusive read" test
      // above), proving one bad entity doesn't abort the rest of the run.
      { poolId: "not-a-real-uuid", configKey: brokenConfigKey, chainSlug: chain.slug },
      { poolId: poolC.id, configKey: poolC.configKey, chainSlug: chain.slug },
    ];

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: entities,
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.entitiesFailed).toBe(1);
    // All 3 were attempted - A and C succeeded despite the broken entity
    // between them in processing order.
    expect(stats!.entitiesProcessed).toBe(3);
    expect(stats!.totalConfirmed).toBe(1); // poolA: stored hash matches
    expect(stats!.totalReorged).toBe(1); // poolC: stored hash (C) no longer matches the injected reader's (A)

    const failedResult = stats!.perEntity.find((e) => e.poolKey === brokenConfigKey);
    expect(failedResult).toBeDefined();
    expect(failedResult!.error).toBeTruthy();
    expect(failedResult!.checked).toBe(0);

    const okResult = stats!.perEntity.find((e) => e.poolKey === poolA.configKey);
    expect(okResult!.confirmed).toBe(1);
  });

  it("reports a lock-contended run as null, not an undifferentiated empty success", async () => {
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    try {
      const [{ locked }] = await holder`select pg_try_advisory_lock(${REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
      expect(locked).toBe(true);

      const result = await recheckPoolTvlReorgs();
      expect(result).toBeNull();
    } finally {
      await holder`select pg_advisory_unlock(${REORG_RECHECK_ADVISORY_LOCK_KEY})`;
      await holder.end();
    }
  });

  it("blocks a second session from acquiring the same session-scoped advisory lock while the first holds it", async () => {
    const connA = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    const connB = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

    try {
      const [{ locked: lockedA }] = await connA`select pg_try_advisory_lock(${REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
      expect(lockedA).toBe(true);

      const [{ locked: lockedB }] = await connB`select pg_try_advisory_lock(${REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
      expect(lockedB).toBe(false);

      await connA`select pg_advisory_unlock(${REORG_RECHECK_ADVISORY_LOCK_KEY})`;

      // Released - a session acquiring it afterward succeeds.
      const [{ locked: lockedAfterRelease }] =
        await connB`select pg_try_advisory_lock(${REORG_RECHECK_ADVISORY_LOCK_KEY}) as locked`;
      expect(lockedAfterRelease).toBe(true);
      await connB`select pg_advisory_unlock(${REORG_RECHECK_ADVISORY_LOCK_KEY})`;
    } finally {
      await connA.end();
      await connB.end();
    }
  });

  it("restricts rechecking to the selected chains when chainSlugs is provided", async () => {
    const chainA = await makeChain();
    const chainB = await makeChain();
    createdChainIds.push(chainA.id, chainB.id);
    const poolA = await makePool(chainA.id);
    const poolB = await makePool(chainB.id);
    createdPoolIds.push(poolA.id, poolB.id);
    await makeObservation(poolA.id, chainA.id, BigInt(50), REAL_HASH_A);
    await makeObservation(poolB.id, chainB.id, BigInt(60), REAL_HASH_B);

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [
        { poolId: poolA.id, configKey: poolA.configKey, chainSlug: chainA.slug },
        { poolId: poolB.id, configKey: poolB.configKey, chainSlug: chainB.slug },
      ],
      chainSlugs: [chainA.slug],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.entitiesConsidered).toBe(1);
    expect(stats!.perEntity).toHaveLength(1);
    expect(stats!.perEntity[0].poolKey).toBe(poolA.configKey);

    const stateB = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, chainB.slug), eq(indexingState.component, `reorg-recheck:pool:${poolB.configKey}`)));
    expect(stateB).toHaveLength(0);
  });
});
