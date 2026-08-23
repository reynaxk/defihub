// Real-Postgres integration test for recordPoolVerification's atomicity -
// separate from verify-pool.test.ts (computePoolTvl's pure, no-DB unit
// tests) since this one needs a real database connection. Mirrors
// pools.test.ts's "transaction atomicity" test for syncPoolsFromConfig:
// force a real constraint violation on the second write inside the
// transaction and confirm the first write rolls back with it.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  });
});
