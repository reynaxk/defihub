// Real-Postgres integration test for recordVaultVerification's atomicity -
// the exact structural twin of verify-pool.integration.test.ts, applied to
// the vault write path (entityType "vault" instead of "pool"). Condensed to
// the highest-value cases from that file's fuller set: rollback, the
// null-vaultId skip, block-identity idempotency, a valid write, the
// missing/malformed-hash skip, and same-block-different-hash (reorg)
// non-deduplication - the same block-hash-identity model verified there,
// now proven to apply identically to vaults.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, onchainVerifications } from "@/lib/database/schema";
import { recordVaultVerification, type VaultVerificationRecord } from "./verify-vault";

describe("recordVaultVerification atomicity", () => {
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
      .values({ name: `Vault Atomicity Test Chain ${randomUUID()}`, slug: `atomicity-vault-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  it("rolls back the whole write when the historical observation insert fails, leaving the previous verification unchanged", async () => {
    const chainId = await makeChain();
    const vaultKey = `atomicity-vault-${randomUUID()}`;
    const vaultId = randomUUID();

    const baseRecord: VaultVerificationRecord = {
      vaultKey,
      protocolId: null,
      chainId,
      label: "Atomicity Test Vault",
      vaultAddress: `0xvault${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "1000.00",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      vaultId,
      tvlUsdForObservation: "1000.00000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    };

    await recordVaultVerification(baseRecord);

    const [before] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultKey));
    expect(before.tvlUsd).toBe("1000.00");

    const failingRecord: VaultVerificationRecord = {
      ...baseRecord,
      tvlUsdForVerification: "9999.99",
      runTimestamp: new Date("2026-01-02T00:00:00.000Z"),
      priceSource: "x".repeat(100), // exceeds price_source's varchar(64) - forces the second insert to fail
    };

    await expect(recordVaultVerification(failingRecord)).rejects.toThrow();

    const [after] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultKey));
    expect(after.tvlUsd).toBe("1000.00");
  });

  it("skips the history write (but still commits the verification) when vaultId is null, matching the pre-existing unsynced-chain behavior", async () => {
    const chainId = await makeChain();
    const vaultKey = `atomicity-vault-nohistory-${randomUUID()}`;

    await recordVaultVerification({
      vaultKey,
      protocolId: null,
      chainId,
      label: "No History Vault",
      vaultAddress: `0xvault${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "50.00",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      vaultId: null,
      tvlUsdForObservation: "50.00000000",
      blockHash: null,
      priceSource: "coingecko",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    });

    const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultKey));
    expect(row.tvlUsd).toBe("50.00");
  });

  it("creates exactly one observation for repeated verification at the same block+hash, and treats a different hash at the same block as a distinct (reorg) observation", async () => {
    const chainId = await makeChain();
    const vaultKey = `block-identity-vault-${randomUUID()}`;
    const vaultId = randomUUID();
    const blockNumber = "19000000";

    const makeRecord = (blockHash: string, runTimestamp: Date): VaultVerificationRecord => ({
      vaultKey,
      protocolId: null,
      chainId,
      label: "Block Identity Test Vault",
      vaultAddress: `0xvault${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "200.00",
      blockNumber,
      runTimestamp,
      vaultId,
      tvlUsdForObservation: "200.00000000",
      blockHash,
      priceSource: "coingecko",
      priceRetrievedAt: runTimestamp,
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    });

    await recordVaultVerification(makeRecord("0x" + "bb".repeat(32), new Date("2026-01-01T00:00:00.000Z")));
    await recordVaultVerification(makeRecord("0x" + "bb".repeat(32), new Date("2026-01-01T00:30:00.000Z")));

    let observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, vaultId));
    expect(observations).toHaveLength(1); // same hash, same block - deduplicated, first timestamp survives
    expect(observations[0].timestamp.getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());

    // A reorg between runs: same block number, different hash.
    await recordVaultVerification(makeRecord("0x" + "cc".repeat(32), new Date("2026-01-01T01:00:00.000Z")));

    observations = await db
      .select()
      .from(historicalObservations)
      .where(eq(historicalObservations.entityId, vaultId))
      .orderBy(historicalObservations.timestamp);
    expect(observations).toHaveLength(2);
    expect(observations.map((o) => o.blockHash)).toEqual(["0x" + "bb".repeat(32), "0x" + "cc".repeat(32)]);
  });

  it("does NOT create a historical observation when the block hash is missing or malformed, but still commits the latest verification", async () => {
    const chainId = await makeChain();
    const vaultId = randomUUID();

    for (const [label, blockHash] of [
      ["missing", null],
      ["malformed", "0xnotarealhash"],
    ] as const) {
      const vaultKey = `${label}-hash-vault-${randomUUID()}`;
      await recordVaultVerification({
        vaultKey,
        protocolId: null,
        chainId,
        label: `${label} hash vault`,
        vaultAddress: `0xvault${randomUUID().slice(0, 8)}`,
        tvlUsdForVerification: "500.00",
        blockNumber: "20500000",
        runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
        vaultId,
        tvlUsdForObservation: "500.00000000",
        blockHash,
        priceSource: "coingecko",
        priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
        calculationInputs: null,
        calculationVersion: "erc4626-total-assets-v1",
      });

      const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultKey));
      expect(row.tvlUsd).toBe("500.00");
    }

    const observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, vaultId));
    expect(observations).toHaveLength(0);
  });
});
