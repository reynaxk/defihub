// Real-Postgres integration test for recordPoolVerification's atomicity -
// separate from verify-pool.test.ts (computePoolTvl's pure, no-DB unit
// tests) since this one needs a real database connection. Mirrors
// pools.test.ts's "transaction atomicity" test for syncPoolsFromConfig:
// force a real constraint violation on the second write inside the
// transaction and confirm the first write rolls back with it.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, onchainVerifications } from "@/lib/database/schema";
import { recordPoolVerification, type PoolVerificationRecord } from "./verify-pool";

describe("recordPoolVerification atomicity", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<string> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Atomicity Test Chain ${randomUUID()}`, slug: `atomicity-verify-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  it("rolls back the whole write when the historical observation insert fails, leaving the previous verification unchanged", async () => {
    const chainId = await makeChain();
    const poolKey = `atomicity-verify-${randomUUID()}`;
    // historical_observations.entity_id is a plain uuid, not a foreign key
    // to pools.id (see that column's own schema comment) - a synthetic
    // uuid is a valid, real target for this test's purposes.
    const poolId = randomUUID();

    const baseRecord: PoolVerificationRecord = {
      poolKey,
      protocolId: null,
      chainId,
      label: "Atomicity Test Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "100.00",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId,
      tvlUsdForObservation: "100.00000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    };

    // Two successful calls, not one: onchain_verifications.verified_at
    // only gets explicitly set on the onConflictDoUpdate path (a bare
    // insert relies on the column's own defaultNow()) - calling twice with
    // the same key exercises that update path, so `before.verifiedAt`
    // below is a known, asserted value rather than "whatever `now` was."
    await recordPoolVerification(baseRecord);
    await recordPoolVerification(baseRecord);

    const [before] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, poolKey));
    expect(before.tvlUsd).toBe("100.00");
    expect(before.verifiedAt.getTime()).toBe(baseRecord.runTimestamp.getTime());
    const observationsBefore = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observationsBefore).toHaveLength(1);

    // A priceSource longer than historical_observations.price_source's
    // varchar(64) limit forces that insert to fail partway through the
    // transaction - deterministic, no need to fight a unique constraint to
    // trigger it. tvlUsdForVerification and runTimestamp are also changed
    // here specifically so a values-persisted check would actually notice
    // if the rollback didn't happen.
    const failingRecord: PoolVerificationRecord = {
      ...baseRecord,
      tvlUsdForVerification: "999.99",
      runTimestamp: new Date("2026-01-02T00:00:00.000Z"),
      priceSource: "x".repeat(100),
    };

    await expect(recordPoolVerification(failingRecord)).rejects.toThrow();

    const [after] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, poolKey));
    expect(after.tvlUsd).toBe("100.00");
    expect(after.verifiedAt.getTime()).toBe(baseRecord.runTimestamp.getTime());

    const observationsAfter = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observationsAfter).toHaveLength(1);
    expect(observationsAfter[0].value).toBe("100.00000000");
  });

  it("skips the history write (but still commits the verification) when poolId is null, matching the pre-existing unsynced-chain behavior", async () => {
    const chainId = await makeChain();
    const poolKey = `atomicity-verify-nohistory-${randomUUID()}`;
    // Synthetic, unused by this call - only here so the negative assertion
    // below has something concrete to search for (entityId is the poolId
    // that would have been used, had one been supplied).
    const wouldBePoolId = randomUUID();

    await recordPoolVerification({
      poolKey,
      protocolId: null,
      chainId,
      label: "No History Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "50.00",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId: null,
      tvlUsdForObservation: "50.00000000",
      blockHash: null,
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, poolKey));
    expect(row.tvlUsd).toBe("50.00");

    // Explicit negative assertion: poolId: null must produce zero
    // historical_observations rows for this key's chain, not merely "we
    // didn't check." entityType/metric/chainId scope the search to rows
    // this call could plausibly have written.
    const observations = await db
      .select()
      .from(historicalObservations)
      .where(
        and(
          eq(historicalObservations.chainId, chainId),
          eq(historicalObservations.entityType, "pool"),
          eq(historicalObservations.metric, "tvl_usd"),
        ),
      );
    expect(observations).toHaveLength(0);
    // Also confirm directly against the specific id no call ever supplied,
    // in case some other test's data happened to share this chain.
    const byWouldBePoolId = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, wouldBePoolId));
    expect(byWouldBePoolId).toHaveLength(0);
  });

  it("repeated verification of the same pool at the same block number and hash produces exactly one historical observation, even with a different runTimestamp each time", async () => {
    const chainId = await makeChain();
    const poolKey = `block-identity-${randomUUID()}`;
    const poolId = randomUUID();
    const blockHash = "0x" + "bb".repeat(32);

    const makeRecord = (runTimestamp: Date): PoolVerificationRecord => ({
      poolKey,
      protocolId: null,
      chainId,
      label: "Block Identity Test Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "200.00",
      blockNumber: "19000000",
      runTimestamp,
      poolId,
      tvlUsdForObservation: "200.00000000",
      blockHash,
      priceSource: "coingecko",
      priceRetrievedAt: runTimestamp,
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    // Three separate "verification runs" against the identical block,
    // each with its own runTimestamp - simulating a cron retry/re-trigger
    // rather than a single call repeated with identical arguments.
    await recordPoolVerification(makeRecord(new Date("2026-01-01T00:00:00.000Z")));
    await recordPoolVerification(makeRecord(new Date("2026-01-01T00:30:00.000Z")));
    await recordPoolVerification(makeRecord(new Date("2026-01-01T01:00:00.000Z")));

    const observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observations).toHaveLength(1);
    // The first run's timestamp survives - onConflictDoNothing means later
    // attempts never overwrite it.
    expect(observations[0].timestamp.getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
  });

  it("creates a historical observation when both block number and block hash are available", async () => {
    const chainId = await makeChain();
    const poolKey = `valid-block-${randomUUID()}`;
    const poolId = randomUUID();

    await recordPoolVerification({
      poolKey,
      protocolId: null,
      chainId,
      label: "Valid Block Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "400.00",
      blockNumber: "20000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId,
      tvlUsdForObservation: "400.00000000",
      blockHash: "0x" + "cc".repeat(32),
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    const observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observations).toHaveLength(1);
    expect(observations[0].blockNumber).toBe("20000000");
    expect(observations[0].blockHash).toBe("0x" + "cc".repeat(32));
  });

  it("does NOT create a historical observation when the block hash is unavailable, even with a real poolId and block number - but still commits the latest verification", async () => {
    const chainId = await makeChain();
    const poolKey = `missing-hash-${randomUUID()}`;
    const poolId = randomUUID();

    await recordPoolVerification({
      poolKey,
      protocolId: null,
      chainId,
      label: "Missing Hash Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "500.00",
      blockNumber: "20500000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId,
      tvlUsdForObservation: "500.00000000",
      blockHash: null,
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    // The latest-value cache still reflects this verification - a missing
    // hash doesn't make the TVL figure itself untrustworthy, only the
    // durable history record of it.
    const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, poolKey));
    expect(row.tvlUsd).toBe("500.00");

    const observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observations).toHaveLength(0);
  });

  it("a retry that later obtains the block hash creates exactly one observation, after an earlier hash-less attempt created none", async () => {
    const chainId = await makeChain();
    const poolKey = `retry-hash-${randomUUID()}`;
    const poolId = randomUUID();
    const blockNumber = "21000000";

    // First attempt: hash unavailable - no observation should result.
    await recordPoolVerification({
      poolKey,
      protocolId: null,
      chainId,
      label: "Retry Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "600.00",
      blockNumber,
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId,
      tvlUsdForObservation: "600.00000000",
      blockHash: null,
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    let observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observations).toHaveLength(0);

    // Retry: same block, hash now obtained - this is the one that should
    // actually persist.
    await recordPoolVerification({
      poolKey,
      protocolId: null,
      chainId,
      label: "Retry Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "600.00",
      blockNumber,
      runTimestamp: new Date("2026-01-01T00:05:00.000Z"),
      poolId,
      tvlUsdForObservation: "600.00000000",
      blockHash: "0x" + "dd".repeat(32),
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:05:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId));
    expect(observations).toHaveLength(1);
    expect(observations[0].blockHash).toBe("0x" + "dd".repeat(32));
  });

  it("the same block number with a different block hash is treated as a distinct observation (a reorg), not deduplicated away", async () => {
    const chainId = await makeChain();
    const poolKey = `block-identity-reorg-${randomUUID()}`;
    const poolId = randomUUID();
    const blockNumber = "19500000";

    const makeRecord = (blockHash: string, runTimestamp: Date): PoolVerificationRecord => ({
      poolKey,
      protocolId: null,
      chainId,
      label: "Reorg Test Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "300.00",
      blockNumber,
      runTimestamp,
      poolId,
      tvlUsdForObservation: "300.00000000",
      blockHash,
      priceSource: "coingecko",
      priceRetrievedAt: runTimestamp,
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    });

    await recordPoolVerification(
      makeRecord("0x" + "11".repeat(32), new Date("2026-01-01T00:00:00.000Z")),
    );
    // Same pool, same block number, a *different* hash - the height was
    // reorged onto different chain history between the two verification
    // runs. Both observations are real and neither should be dropped.
    await recordPoolVerification(
      makeRecord("0x" + "22".repeat(32), new Date("2026-01-01T00:30:00.000Z")),
    );

    const observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, poolId))
      .orderBy(historicalObservations.timestamp);
    expect(observations).toHaveLength(2);
    expect(observations.map((o) => o.blockHash)).toEqual(["0x" + "11".repeat(32), "0x" + "22".repeat(32)]);
    expect(observations.every((o) => o.blockNumber === blockNumber)).toBe(true);
  });
});
