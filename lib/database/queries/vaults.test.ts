// Real-Postgres integration tests for the vault TVL query functions - the
// exact structural twin of pools.test.ts, applied to `vaults`/entityType
// "vault" instead of `pools`/"pool".
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, historicalObservations, vaults } from "@/lib/database/schema";
import { getVaultObservationCount, getVaultTvlHistory, getVerifiedVaults, normalizeVaultTvlHistoryLimit } from "./vaults";

const PIVOT = new Date("2026-02-01T00:00:00.000Z");
const BEFORE = new Date(PIVOT.getTime() - 60 * 60 * 1000);
const AFTER = new Date(PIVOT.getTime() + 60 * 60 * 1000);

let blockCounter = 40_000_000;
function nextBlock() {
  blockCounter += 1;
  return { blockNumber: String(blockCounter), blockHash: `0xblock${randomUUID()}` };
}

describe("vault TVL query functions", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChainAndVault() {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Vault Chain ${randomUUID()}`, slug: `test-vault-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const [vault] = await db
      .insert(vaults)
      .values({
        configKey: `test-vault-${randomUUID()}`,
        chainId: chain.id,
        label: "Test Vault",
        address: `0xvault${randomUUID().slice(0, 8)}`,
        underlyingAddress: `0xunderlying${randomUUID().slice(0, 8)}`,
        underlyingSymbol: "DAI",
        underlyingDecimals: 18,
        underlyingCoingeckoId: "dai",
      })
      .returning({ id: vaults.id });

    return { chainId: chain.id, vaultId: vault.id };
  }

  describe("getVaultTvlHistory", () => {
    it("includes an observation exactly at the cutoff and excludes one before it", async () => {
      const { chainId, vaultId } = await makeChainAndVault();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "100", timestamp: BEFORE, source: "onchain-verification", ...nextBlock() },
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "200", timestamp: PIVOT, source: "onchain-verification", ...nextBlock() },
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "300", timestamp: AFTER, source: "onchain-verification", ...nextBlock() },
      ]);

      const bounded = await getVaultTvlHistory(vaultId, PIVOT);
      expect(bounded.map((r) => r.value)).toEqual(["200.00000000", "300.00000000"]);
    });

    it("never returns another vault's or a pool's observations, even a pool with the exact same entityId by coincidence", async () => {
      const { chainId, vaultId } = await makeChainAndVault();
      const other = await makeChainAndVault();
      await db.insert(historicalObservations).values([
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "100", timestamp: PIVOT, source: "onchain-verification", ...nextBlock() },
        { chainId: other.chainId, entityType: "vault", entityId: other.vaultId, metric: "tvl_usd", value: "999", timestamp: PIVOT, source: "onchain-verification", ...nextBlock() },
        // Same id, but entityType "pool" - must not leak into a vault query.
        { chainId, entityType: "pool", entityId: vaultId, metric: "tvl_usd", value: "999", timestamp: PIVOT, source: "onchain-verification", ...nextBlock() },
      ]);

      const result = await getVaultTvlHistory(vaultId, null);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("100.00000000");
    });

    it("excludes an observation workers/onchain/recheck-reorgs.ts has since marked as reorged, and shows a later canonical replacement", async () => {
      const { chainId, vaultId } = await makeChainAndVault();
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "vault",
          entityId: vaultId,
          metric: "tvl_usd",
          value: "100",
          timestamp: BEFORE,
          source: "onchain-verification",
          reorgInvalidatedAt: new Date(),
          ...nextBlock(),
        },
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "150", timestamp: AFTER, source: "onchain-verification", ...nextBlock() },
      ]);

      const result = await getVaultTvlHistory(vaultId, null);
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("150.00000000");
    });

    it("preserves block hash and calculation-input provenance through the read path", async () => {
      const { chainId, vaultId } = await makeChainAndVault();
      const blockHash = "0x" + "ab".repeat(32);
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "vault",
          entityId: vaultId,
          metric: "tvl_usd",
          value: "4902.87500000",
          timestamp: PIVOT,
          blockNumber: "18000000",
          blockHash,
          priceSource: "coingecko",
          calculationInputs: [{ symbol: "DAI", coingeckoId: "dai", decimals: 18, balanceRaw: "4902875000000000000000", priceUsd: "1.00" }],
          source: "onchain-verification",
          calculationVersion: "erc4626-total-assets-v1",
        },
      ]);

      const [row] = await getVaultTvlHistory(vaultId, null);
      expect(row.blockHash).toBe(blockHash);
      expect(row.calculationVersion).toBe("erc4626-total-assets-v1");
      expect(row.calculationInputs).toHaveLength(1);
    });
  });

  describe("normalizeVaultTvlHistoryLimit", () => {
    it("corrects zero to the safe minimum", () => {
      expect(normalizeVaultTvlHistoryLimit(0)).toBe(1);
    });

    it("clamps a very large value down to the documented default/max", () => {
      expect(normalizeVaultTvlHistoryLimit(10_000)).toBe(5000);
    });
  });

  describe("getVaultObservationCount", () => {
    it("counts observations, excluding a reorg-invalidated one, and reports the earliest surviving timestamp", async () => {
      const { chainId, vaultId } = await makeChainAndVault();
      await db.insert(historicalObservations).values([
        {
          chainId,
          entityType: "vault",
          entityId: vaultId,
          metric: "tvl_usd",
          value: "1",
          timestamp: BEFORE,
          source: "onchain-verification",
          reorgInvalidatedAt: new Date(),
          ...nextBlock(),
        },
        { chainId, entityType: "vault", entityId: vaultId, metric: "tvl_usd", value: "2", timestamp: AFTER, source: "onchain-verification", ...nextBlock() },
      ]);

      const result = await getVaultObservationCount(vaultId);
      expect(result.count).toBe(1);
      expect(result.earliestAt?.getTime()).toBe(AFTER.getTime());
    });

    it("returns a real zero and a null earliestAt for a vault with no observations yet", async () => {
      const { vaultId } = await makeChainAndVault();
      const result = await getVaultObservationCount(vaultId);
      expect(result.count).toBe(0);
      expect(result.earliestAt).toBeNull();
    });
  });

  describe("getVerifiedVaults", () => {
    it("includes a vault synced from config but never yet verified, with a null latestTvlUsd rather than omitting it", async () => {
      const { vaultId } = await makeChainAndVault();
      const all = await getVerifiedVaults();
      const found = all.find((v) => v.id === vaultId);
      expect(found).toBeDefined();
      expect(found?.latestTvlUsd).toBeNull();
      expect(found?.underlyingSymbol).toBe("DAI");
    });
  });
});
