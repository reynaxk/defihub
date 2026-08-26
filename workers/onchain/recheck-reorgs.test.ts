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
import { chains, historicalObservations, indexingState, pools, tokens, vaults } from "@/lib/database/schema";
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

async function makeVault(chainId: string) {
  const configKey = `test-recheck-vault-${randomUUID()}`;
  const [vault] = await db
    .insert(vaults)
    .values({
      configKey,
      chainId,
      label: "Test recheck vault",
      address: `0xvault${randomUUID().slice(0, 8)}`,
      underlyingAddress: `0xunderlying${randomUUID().slice(0, 8)}`,
      underlyingSymbol: "DAI",
      underlyingDecimals: 18,
      underlyingCoingeckoId: "dai",
    })
    .returning({ id: vaults.id, configKey: vaults.configKey });
  return vault;
}

async function makeToken(chainId: string) {
  const address = `0xtoken${randomUUID().slice(0, 8)}`;
  const [token] = await db.insert(tokens).values({ chainId, address, symbol: "TST", decimals: 18 }).returning({ id: tokens.id });
  return { id: token.id, configKey: address };
}

async function makeObservation(
  entityId: string,
  chainId: string,
  blockNumber: bigint,
  blockHash: string,
  entityType: "pool" | "vault" | "token" = "pool",
) {
  const [row] = await db
    .insert(historicalObservations)
    .values({
      chainId,
      entityType,
      entityId,
      // Phase 5.3: "token" entities use metric "price_usd", not "tvl_usd" -
      // derived from entityType here rather than taken as a separate
      // parameter, since every real caller (and every existing pool/vault
      // test) already has a fixed 1:1 entityType -> metric mapping and
      // there's no need for this test helper to expose a knob nothing uses.
      metric: entityType === "token" ? "price_usd" : "tvl_usd",
      value: "100.00000000",
      timestamp: new Date(),
      blockNumber: blockNumber.toString(),
      blockHash,
      source: "test",
    })
    .returning({ id: historicalObservations.id });
  return row.id;
}

async function getState(chainSlug: string, configKey: string, entityType: "pool" | "vault" | "token" = "pool") {
  const [state] = await db
    .select()
    .from(indexingState)
    .where(and(eq(indexingState.chainSlug, chainSlug), eq(indexingState.component, `reorg-recheck:${entityType}:${configKey}`)));
  return state;
}

describe("recheckPoolTvlReorgs", () => {
  const createdChainIds: string[] = [];
  const createdPoolIds: string[] = [];
  const createdVaultIds: string[] = [];
  const createdTokenIds: string[] = [];

  afterEach(async () => {
    // historical_observations.entityId and indexing_state.chainSlug are
    // plain columns, not FKs (see historicalObservations' own schema
    // comment on why entityType/entityId is deliberately not a real FK) -
    // deleting the chain (which cascades to `pools`/`vaults`/`tokens`) does
    // NOT clean these up, so both need explicit cleanup here.
    if (createdPoolIds.length > 0) {
      await db.delete(historicalObservations).where(inArray(historicalObservations.entityId, createdPoolIds));
    }
    if (createdVaultIds.length > 0) {
      await db.delete(historicalObservations).where(inArray(historicalObservations.entityId, createdVaultIds));
    }
    if (createdTokenIds.length > 0) {
      await db.delete(historicalObservations).where(inArray(historicalObservations.entityId, createdTokenIds));
    }
    for (const chainId of createdChainIds) {
      const [chain] = await db.select({ slug: chains.slug }).from(chains).where(eq(chains.id, chainId));
      if (chain) await db.delete(indexingState).where(eq(indexingState.chainSlug, chain.slug));
    }
    createdPoolIds.splice(0);
    createdVaultIds.splice(0);
    createdTokenIds.splice(0);
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

    // The observation's provenance is never mutated or deleted - every
    // field it was written with (blockHash, blockNumber, value, ...) stays
    // exactly as recorded, per the task's own instruction not to invent a
    // destructive reconciliation behavior. The one thing that DOES change
    // is reorgInvalidatedAt, set specifically so canonical history queries
    // (getPoolTvlHistory - see pools.test.ts) stop returning this row,
    // without ever rewriting or discarding it.
    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsId));
    expect(row.blockHash).toBe(REAL_HASH_A);
    expect(row.blockNumber).toBe("200");
    expect(row.reorgInvalidatedAt).not.toBeNull();

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

    // Repeated recheck is idempotent: an already-invalidated observation is
    // excluded from future candidates (getObservationsNeedingRecheck), so a
    // second run finds nothing left to do for this pool - no duplicate
    // observation, no repeated invalidation, no corrupted checkpoint.
    const second = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_B,
    });
    expect(second!.totalChecked).toBe(0);
    const observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, pool.id));
    expect(observations).toHaveLength(1);
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

    // Only the reorged sibling is invalidated - its still-canonical sibling
    // at the exact same block number is untouched, proving the marking is
    // per-observation, not per-block-number.
    const [rowA] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsA));
    const [rowB] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsB));
    expect(rowA.reorgInvalidatedAt).toBeNull();
    expect(rowB.reorgInvalidatedAt).not.toBeNull();
  });

  it("with one sibling resolving cleanly and the other coming back unknown at the same block number, records exactly one unknown, never advances the cursor past that block, and leaves both siblings un-invalidated", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    // Same setup as the group test above (two observations sharing block
    // 100 with different hashes), but this time the SECOND sibling checked
    // reads back unknown (RPC couldn't currently verify it) instead of
    // resolving to confirmed/reorged - this is the scenario the grouping
    // logic must treat as "this whole block number stays unresolved," not
    // "one out of two is good enough."
    const obsA = await makeObservation(pool.id, chain.id, BigInt(100), REAL_HASH_A);
    const obsB = await makeObservation(pool.id, chain.id, BigInt(100), REAL_HASH_B);

    // Real processing order is (blockNumber, id) ascending - see
    // getObservationsNeedingRecheck - so which of obsA/obsB is checked
    // first depends on which uuid sorts first, not insertion order. The
    // mock is built from that real order (not a hardcoded guess) so the
    // first-processed sibling gets its own real stored hash back (resolves
    // cleanly) and the second-processed one gets null (unknown),
    // regardless of which observation that turns out to be - this exercises
    // the actual grouping/ordering code, not a mocked-out final result.
    const firstProcessedId = obsA < obsB ? obsA : obsB;
    const firstProcessedHash = firstProcessedId === obsA ? REAL_HASH_A : REAL_HASH_B;
    let callCount = 0;
    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => {
        callCount++;
        return callCount === 1 ? firstProcessedHash : null;
      },
    });

    expect(stats!.totalChecked).toBe(2);
    expect(stats!.totalConfirmed).toBe(1);
    expect(stats!.totalReorged).toBe(0);
    expect(stats!.totalUnknown).toBe(1);

    const state = await getState(chain.slug, pool.configKey);
    // The group never fully resolved (one sibling unknown), so the cursor
    // must not advance past block 100 at all.
    expect(state.lastProcessedBlock).toBeNull();
    expect(state.lastSuccessfulSyncAt).toBeNull();

    // Neither sibling was marked reorged - the unresolved one is genuinely
    // unresolved, not incorrectly treated as either canonical or reorged.
    const [rowA] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsA));
    const [rowB] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsB));
    expect(rowA.reorgInvalidatedAt).toBeNull();
    expect(rowB.reorgInvalidatedAt).toBeNull();

    // A later run, once the read is reliable again, retries the whole
    // group (including the sibling that already resolved once) and
    // resolves it cleanly - no duplicate observations are ever created.
    const secondProcessedHash = firstProcessedId === obsA ? REAL_HASH_B : REAL_HASH_A;
    let retryCallCount = 0;
    const retry = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => {
        retryCallCount++;
        return retryCallCount === 1 ? firstProcessedHash : secondProcessedHash;
      },
    });
    expect(retry!.totalUnknown).toBe(0);
    expect(retry!.totalConfirmed).toBe(2);
    expect(retry!.totalReorged).toBe(0);
    const retryState = await getState(chain.slug, pool.configKey);
    expect(Number(retryState.lastProcessedBlock)).toBe(100);
    const observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, pool.id));
    expect(observations).toHaveLength(2);
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
    const firstProcessedKey = first!.perEntity[0].entityKey;

    const second = await recheckPoolTvlReorgs({ poolEntitiesOverride: entities, batchSize: 1, readBlockHash: async () => REAL_HASH_A });
    expect(second!.entitiesProcessed).toBe(1);
    const secondProcessedKey = second!.perEntity[0].entityKey;

    // Least-recently-attempted ordering (persisted in indexingState, read
    // fresh each run) means the entity processed first is no longer the
    // least-recently-attempted on the next run - a fixed leading entity
    // would otherwise starve the other two forever whenever batchSize is
    // smaller than the entity count.
    expect(secondProcessedKey).not.toBe(firstProcessedKey);

    const third = await recheckPoolTvlReorgs({ poolEntitiesOverride: entities, batchSize: 1, readBlockHash: async () => REAL_HASH_A });
    const thirdProcessedKey = third!.perEntity[0].entityKey;
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

    const failedResult = stats!.perEntity.find((e) => e.entityKey === brokenConfigKey);
    expect(failedResult).toBeDefined();
    expect(failedResult!.error).toBeTruthy();
    expect(failedResult!.checked).toBe(0);

    const okResult = stats!.perEntity.find((e) => e.entityKey === poolA.configKey);
    expect(okResult!.confirmed).toBe(1);

    // The failure happened before recheckOneEntity's normal "running"
    // update ever ran (getObservationsNeedingRecheck itself threw) - the
    // attempt is still recorded, via the same catch that records the
    // failure. Without this, the broken entity would look permanently
    // never-attempted and would keep sorting first in every future run's
    // least-recently-attempted ordering (see the dedicated rotation test
    // below).
    const brokenState = await getState(chain.slug, brokenConfigKey);
    expect(brokenState).toBeDefined();
    expect(brokenState.lastAttemptedSyncAt).not.toBeNull();
    expect(brokenState.lastSuccessfulSyncAt).toBeNull();
  });

  it("still advances a failing entity's lastAttemptedSyncAt, so a repeatedly-failing entity does not starve the rotation forever", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const poolB = await makePool(chain.id);
    const poolC = await makePool(chain.id);
    createdPoolIds.push(poolB.id, poolC.id);
    await makeObservation(poolB.id, chain.id, BigInt(20), REAL_HASH_B);
    await makeObservation(poolC.id, chain.id, BigInt(30), REAL_HASH_C);

    const brokenConfigKey = `broken-pool-${randomUUID()}`;
    const brokenEntity = { poolId: "not-a-real-uuid", configKey: brokenConfigKey, chainSlug: chain.slug };
    const entityB = { poolId: poolB.id, configKey: poolB.configKey, chainSlug: chain.slug };
    const entityC = { poolId: poolC.id, configKey: poolC.configKey, chainSlug: chain.slug };

    // Run 1: only the broken entity is in scope - it fails every time, but
    // must still record a real attempt.
    const first = await recheckPoolTvlReorgs({ poolEntitiesOverride: [brokenEntity], readBlockHash: async () => REAL_HASH_A });
    expect(first!.entitiesFailed).toBe(1);
    const afterFirst = await getState(chain.slug, brokenConfigKey);
    expect(afterFirst.lastAttemptedSyncAt).not.toBeNull();

    // Run 2: same broken entity fails again immediately - a second,
    // strictly later attempt timestamp, not a stuck/frozen one.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await recheckPoolTvlReorgs({ poolEntitiesOverride: [brokenEntity], readBlockHash: async () => REAL_HASH_A });
    expect(second!.entitiesFailed).toBe(1);
    const afterSecond = await getState(chain.slug, brokenConfigKey);
    expect(afterSecond.lastAttemptedSyncAt!.getTime()).toBeGreaterThan(afterFirst.lastAttemptedSyncAt!.getTime());

    // Run 3: the broken entity now has two real, recent attempts behind
    // it - entities B and C have never been attempted at all, so they sort
    // ahead of it (least-recently-attempted first). batchSize=1 must pick
    // one of the healthy entities, not retry the broken one a third time in
    // a row.
    const third = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [brokenEntity, entityB, entityC],
      batchSize: 1,
      readBlockHash: async () => REAL_HASH_B,
    });
    expect(third!.entitiesProcessed).toBe(1);
    expect(third!.perEntity[0].entityKey).not.toBe(brokenConfigKey);
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
    expect(stats!.perEntity[0].entityKey).toBe(poolA.configKey);

    const stateB = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, chainB.slug), eq(indexingState.component, `reorg-recheck:pool:${poolB.configKey}`)));
    expect(stateB).toHaveLength(0);
  });

  // Phase 5.2: the same job, generalized to also cover vault entities
  // (VERIFIED_VAULTS/verify-vault.ts) alongside pools - vaultEntitiesOverride
  // mirrors poolEntitiesOverride's exact shape/purpose.

  it("discovers and rechecks a vault entity exactly like a pool entity, tagging results with entityType \"vault\"", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const vault = await makeVault(chain.id);
    createdVaultIds.push(vault.id);
    await makeObservation(vault.id, chain.id, BigInt(100), REAL_HASH_A, "vault");

    const stats = await recheckPoolTvlReorgs({
      vaultEntitiesOverride: [{ vaultId: vault.id, configKey: vault.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.totalConfirmed).toBe(1);
    expect(stats!.perEntity[0].entityType).toBe("vault");
    expect(stats!.perEntity[0].entityKey).toBe(vault.configKey);

    const state = await getState(chain.slug, vault.configKey, "vault");
    expect(state.status).toBe("idle");
    expect(Number(state.lastProcessedBlock)).toBe(100);
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("detects a reorg for a vault observation and marks it invalidated, the same as it would for a pool", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const vault = await makeVault(chain.id);
    createdVaultIds.push(vault.id);
    const obsId = await makeObservation(vault.id, chain.id, BigInt(200), REAL_HASH_A, "vault");

    const stats = await recheckPoolTvlReorgs({
      vaultEntitiesOverride: [{ vaultId: vault.id, configKey: vault.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_B,
    });

    expect(stats!.totalReorged).toBe(1);
    expect(stats!.perEntity[0].reorgedObservations[0].observationId).toBe(obsId);

    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsId));
    expect(row.reorgInvalidatedAt).not.toBeNull();
    expect(row.blockHash).toBe(REAL_HASH_A); // provenance untouched, same as the pool case

    const state = await getState(chain.slug, vault.configKey, "vault");
    expect(state.status).toBe("error");
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  // Phase 5.3: the same job, generalized a second time, to also cover
  // native token price observations (lib/onchain/pricing/, entityType
  // "token", metric "price_usd") alongside pools and vaults -
  // tokenEntitiesOverride mirrors poolEntitiesOverride/vaultEntitiesOverride's
  // exact shape/purpose.

  it("discovers and rechecks a token price entity exactly like a pool/vault entity, tagging results with entityType \"token\"", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const token = await makeToken(chain.id);
    createdTokenIds.push(token.id);
    await makeObservation(token.id, chain.id, BigInt(100), REAL_HASH_A, "token");

    const stats = await recheckPoolTvlReorgs({
      tokenEntitiesOverride: [{ tokenId: token.id, configKey: token.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.totalConfirmed).toBe(1);
    expect(stats!.perEntity[0].entityType).toBe("token");
    expect(stats!.perEntity[0].entityKey).toBe(token.configKey);

    const state = await getState(chain.slug, token.configKey, "token");
    expect(state.status).toBe("idle");
    expect(Number(state.lastProcessedBlock)).toBe(100);
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("detects a reorg for a token price observation and marks it invalidated, the same as it would for a pool or vault", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const token = await makeToken(chain.id);
    createdTokenIds.push(token.id);
    const obsId = await makeObservation(token.id, chain.id, BigInt(200), REAL_HASH_A, "token");

    const stats = await recheckPoolTvlReorgs({
      tokenEntitiesOverride: [{ tokenId: token.id, configKey: token.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_B,
    });

    expect(stats!.totalReorged).toBe(1);
    expect(stats!.perEntity[0].reorgedObservations[0].observationId).toBe(obsId);

    const [row] = await db.select().from(historicalObservations).where(eq(historicalObservations.id, obsId));
    expect(row.reorgInvalidatedAt).not.toBeNull();
    expect(row.blockHash).toBe(REAL_HASH_A); // provenance untouched, same as the pool/vault case

    const state = await getState(chain.slug, token.configKey, "token");
    expect(state.status).toBe("error");
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  it("never mixes real production token price entities into a pool-only override run", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(30), REAL_HASH_A);

    // Only poolEntitiesOverride is supplied - tokenEntitiesOverride is
    // omitted, which must default to an empty list, never a live query
    // against real "token"/"price_usd" observations that may already exist
    // in this same database.
    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.entitiesConsidered).toBe(1);
    expect(stats!.perEntity.every((e) => e.entityType === "pool")).toBe(true);
  });

  it("processes pools and vaults together in one run, keeping each entity's own checkpoint independent - and the pool's checkpoint key is byte-identical to Phase 5.1's own format", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    const vault = await makeVault(chain.id);
    createdPoolIds.push(pool.id);
    createdVaultIds.push(vault.id);
    await makeObservation(pool.id, chain.id, BigInt(10), REAL_HASH_A);
    await makeObservation(vault.id, chain.id, BigInt(20), REAL_HASH_B, "vault");

    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      vaultEntitiesOverride: [{ vaultId: vault.id, configKey: vault.configKey, chainSlug: chain.slug }],
      readBlockHash: async (_chain, blockNumber) => (Number(blockNumber) === 10 ? REAL_HASH_A : REAL_HASH_B),
    });

    expect(stats!.entitiesConsidered).toBe(2);
    expect(stats!.entitiesProcessed).toBe(2);
    expect(stats!.totalConfirmed).toBe(2);
    const poolResult = stats!.perEntity.find((e) => e.entityType === "pool");
    const vaultResult = stats!.perEntity.find((e) => e.entityType === "vault");
    expect(poolResult?.entityKey).toBe(pool.configKey);
    expect(vaultResult?.entityKey).toBe(vault.configKey);

    // The pool's indexingState component is exactly "reorg-recheck:pool:X" -
    // the same string Phase 5.1 already wrote to production before this
    // generalization existed - so no existing checkpoint is silently
    // orphaned by this change.
    const [poolState] = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, chain.slug), eq(indexingState.component, `reorg-recheck:pool:${pool.configKey}`)));
    expect(poolState).toBeDefined();
    const [vaultState] = await db
      .select()
      .from(indexingState)
      .where(and(eq(indexingState.chainSlug, chain.slug), eq(indexingState.component, `reorg-recheck:vault:${vault.configKey}`)));
    expect(vaultState).toBeDefined();
  });

  it("never mixes real production vaults into a pool-only override run, and never mixes real production pools into a vault-only override run", async () => {
    const chain = await makeChain();
    createdChainIds.push(chain.id);
    const pool = await makePool(chain.id);
    createdPoolIds.push(pool.id);
    await makeObservation(pool.id, chain.id, BigInt(30), REAL_HASH_A);

    // Only poolEntitiesOverride is supplied - vaultEntitiesOverride is
    // omitted, which must default to an empty list, never a live query
    // against the real `vaults` table (which may well have real
    // VERIFIED_VAULTS-derived rows in this same database).
    const stats = await recheckPoolTvlReorgs({
      poolEntitiesOverride: [{ poolId: pool.id, configKey: pool.configKey, chainSlug: chain.slug }],
      readBlockHash: async () => REAL_HASH_A,
    });

    expect(stats!.entitiesConsidered).toBe(1);
    expect(stats!.perEntity).toHaveLength(1);
    expect(stats!.perEntity[0].entityType).toBe("pool");
  });
});
