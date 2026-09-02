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
import { recordPoolVerification, type PoolVerificationRecord } from "./verify-pool";
import { recordVaultVerification, type VaultVerificationRecord } from "./verify-vault";

// Must match VAULT_VERIFICATION_KEY_PREFIX in verify-vault.ts exactly - see
// that constant's own comment for why onchain_verifications.key needs this
// namespacing at all (one shared key column across pools/vaults/legacy
// protocol-TVL entries).
function vaultVerificationKey(vaultKey: string): string {
  return `vault:${vaultKey}`;
}

describe("recordVaultVerification atomicity", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  // closeDb() is deliberately NOT called here - it closes the shared,
  // module-level connection pool (lib/database/client.ts), not something
  // scoped to just this describe block. Calling it here would leave the
  // "pool/vault verification identity collision" describe block further
  // down this same file trying to query through an already-closed
  // connection. Only the last describe block in this file closes it - see
  // its own afterAll below.

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
    // A short suffix (not a full UUID) - onchain_verifications.key is
    // varchar(64), and the "vault:" namespace prefix (record-verification.ts,
    // verify-vault.ts) adds 6 more characters on top of whatever this test
    // builds; a full-length randomUUID() suffix combined with a descriptive
    // key prefix genuinely overflowed that column here (a real, caught test
    // bug, not a hypothetical one - production VERIFIED_VAULTS keys are far
    // shorter, e.g. "sdai-ethereum", so this was purely a test-key-length
    // issue). Matches the same `.slice(0, 8)` convention already used below
    // for vaultAddress.
    const vaultKey = `atomicity-vault-${randomUUID().slice(0, 8)}`;
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
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    };

    await recordVaultVerification(baseRecord);

    const [before] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));
    expect(before.tvlUsd).toBe("1000.00");

    const failingRecord: VaultVerificationRecord = {
      ...baseRecord,
      tvlUsdForVerification: "9999.99",
      runTimestamp: new Date("2026-01-02T00:00:00.000Z"),
      priceSource: "x".repeat(100), // exceeds price_source's varchar(64) - forces the second insert to fail
    };

    await expect(recordVaultVerification(failingRecord)).rejects.toThrow();

    const [after] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));
    expect(after.tvlUsd).toBe("1000.00");
  });

  it("skips the history write (but still commits the verification) when vaultId is null, matching the pre-existing unsynced-chain behavior", async () => {
    const chainId = await makeChain();
    const vaultKey = `atomicity-vault-nohistory-${randomUUID().slice(0, 8)}`;

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
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    });

    const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));
    expect(row.tvlUsd).toBe("50.00");
  });

  it("creates exactly one observation for repeated verification at the same block+hash, and treats a different hash at the same block as a distinct (reorg) observation", async () => {
    const chainId = await makeChain();
    const vaultKey = `block-identity-vault-${randomUUID().slice(0, 8)}`;
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
      priceLabel: "EXTERNAL_FALLBACK",
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
      const vaultKey = `${label}-hash-vault-${randomUUID().slice(0, 8)}`;
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
        priceLabel: "EXTERNAL_FALLBACK",
        priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
        calculationInputs: null,
        calculationVersion: "erc4626-total-assets-v1",
      });

      const [row] = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));
      expect(row.tvlUsd).toBe("500.00");
    }

    const observations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, vaultId));
    expect(observations).toHaveLength(0);
  });

  it("refreshes label and poolAddress (not just the verification-specific fields) when the same verification key is reused with new metadata, never leaving current TVL associated with stale metadata", async () => {
    const chainId = await makeChain();
    const vaultKey = `metadata-refresh-vault-${randomUUID().slice(0, 8)}`;
    const vaultId = randomUUID();

    const addressA = `0xvault${randomUUID().slice(0, 8)}`;
    await recordVaultVerification({
      vaultKey,
      protocolId: null,
      chainId,
      label: "Stale Label A",
      vaultAddress: addressA,
      tvlUsdForVerification: "1000.00",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      vaultId,
      tvlUsdForObservation: "1000.00000000",
      blockHash: "0x" + "aa".repeat(32),
      priceSource: "coingecko",
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    });

    const [afterFirstWrite] = await db
      .select()
      .from(onchainVerifications)
      .where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));
    expect(afterFirstWrite.label).toBe("Stale Label A");
    expect(afterFirstWrite.poolAddress).toBe(addressA);

    // The exact same effective verification key, reused with different
    // metadata - the scenario this fix targets: without refreshing
    // label/poolAddress on conflict, the row below would keep reporting
    // "Stale Label A" / addressA even though its tvlUsd/blockNumber now
    // genuinely reflect a different vault entity's state.
    const addressB = `0xvault${randomUUID().slice(0, 8)}`;
    await recordVaultVerification({
      vaultKey,
      protocolId: null,
      chainId,
      label: "Fresh Label B",
      vaultAddress: addressB,
      tvlUsdForVerification: "2000.00",
      blockNumber: "18000100",
      runTimestamp: new Date("2026-01-02T00:00:00.000Z"),
      vaultId,
      tvlUsdForObservation: "2000.00000000",
      blockHash: "0x" + "bb".repeat(32),
      priceSource: "coingecko",
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-02T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    });

    const [afterSecondWrite] = await db
      .select()
      .from(onchainVerifications)
      .where(eq(onchainVerifications.key, vaultVerificationKey(vaultKey)));

    // The metadata this fix targets - refreshed to B, not stuck on stale A.
    expect(afterSecondWrite.label).toBe("Fresh Label B");
    expect(afterSecondWrite.poolAddress).toBe(addressB);
    // The verification fields this conflict path already refreshed
    // correctly before this fix - still correct afterwards.
    expect(afterSecondWrite.tvlUsd).toBe("2000.00");
    expect(afterSecondWrite.blockNumber).toBe("18000100");
    expect(afterSecondWrite.verifiedAt.getTime()).toBe(new Date("2026-01-02T00:00:00.000Z").getTime());
  });
});

describe("pool/vault verification identity collision", () => {
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
      .values({ name: `Collision Test Chain ${randomUUID()}`, slug: `collision-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  it("keeps a pool and a vault verification fully distinct even when they're given the exact same logical config key", async () => {
    const chainId = await makeChain();
    const poolId = randomUUID();
    const vaultId = randomUUID();
    // The exact same logical key on purpose - this is precisely the
    // scenario assertUniqueVerificationKeys (lib/onchain/config.ts) exists
    // to reject at the real-config level, but this test calls
    // recordPoolVerification/recordVaultVerification directly (bypassing
    // VERIFIED_POOLS/VERIFIED_VAULTS entirely) specifically to prove the
    // underlying write path itself - namespacing, not just config
    // discipline - is what actually prevents the collision.
    const collidingKey = `colliding-key-${randomUUID().slice(0, 8)}`;

    const poolRecord: PoolVerificationRecord = {
      poolKey: collidingKey,
      protocolId: null,
      chainId,
      label: "Colliding Pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "111.11",
      blockNumber: "18000000",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      poolId,
      tvlUsdForObservation: "111.11000000",
      blockHash: "0x" + "11".repeat(32),
      priceSource: "coingecko",
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "pool-balance-sum-v1",
    };
    const vaultRecord: VaultVerificationRecord = {
      vaultKey: collidingKey,
      protocolId: null,
      chainId,
      label: "Colliding Vault",
      vaultAddress: `0xvault${randomUUID().slice(0, 8)}`,
      tvlUsdForVerification: "222.22",
      blockNumber: "18000001",
      runTimestamp: new Date("2026-01-01T00:00:00.000Z"),
      vaultId,
      tvlUsdForObservation: "222.22000000",
      blockHash: "0x" + "22".repeat(32),
      priceSource: "coingecko",
      priceLabel: "EXTERNAL_FALLBACK",
      priceRetrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      calculationInputs: null,
      calculationVersion: "erc4626-total-assets-v1",
    };

    // Order matters for what this test actually proves: the vault is
    // recorded SECOND, specifically so that if the two ever did share one
    // onchain_verifications row, this write would be the one to silently
    // clobber the pool's - the exact failure mode being guarded against.
    await recordPoolVerification(poolRecord);
    await recordVaultVerification(vaultRecord);

    // Both verification records remain distinct - two real rows, not one.
    const poolRow = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, collidingKey));
    const vaultRow = await db.select().from(onchainVerifications).where(eq(onchainVerifications.key, vaultVerificationKey(collidingKey)));
    expect(poolRow).toHaveLength(1);
    expect(vaultRow).toHaveLength(1);

    // Neither overwrote the other.
    expect(poolRow[0].tvlUsd).toBe("111.11");
    expect(poolRow[0].poolAddress).toBe(poolRecord.poolAddress);
    expect(vaultRow[0].tvlUsd).toBe("222.22");
    expect(vaultRow[0].poolAddress).toBe(vaultRecord.vaultAddress);

    // Pool behavior remains correct - unaffected by the vault write that
    // came after it.
    const poolObservations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, poolId));
    expect(poolObservations).toHaveLength(1);
    expect(poolObservations[0].entityType).toBe("pool");
    expect(poolObservations[0].value).toBe("111.11000000");

    const vaultObservations = await db.select().from(historicalObservations).where(eq(historicalObservations.entityId, vaultId));
    expect(vaultObservations).toHaveLength(1);
    expect(vaultObservations[0].entityType).toBe("vault");
    expect(vaultObservations[0].value).toBe("222.22000000");
  });
});
