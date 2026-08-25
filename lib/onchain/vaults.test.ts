// Real-Postgres integration test for syncVaultsFromConfig - the exact
// structural twin of pools.test.ts's syncPoolsFromConfig test, applied to
// VERIFIED_VAULTS/`vaults` instead of VERIFIED_POOLS/`pools`. Runs against
// the real VERIFIED_VAULTS config, since the thing under test is
// specifically "does the real config sync correctly."
//
// No afterEach cleanup, matching pools.test.ts's own reasoning: this
// function's whole job is to populate `vaults` with the real, permanent
// canonical rows VERIFIED_VAULTS describes - those are the intended
// production data, not disposable test fixtures.
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, vaults } from "@/lib/database/schema";
import { VERIFIED_VAULTS } from "./config";
import { syncVaultsFromConfig } from "./vaults";

const REAL_VAULT_KEYS = VERIFIED_VAULTS.map((v) => v.key);

describe("syncVaultsFromConfig", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("upserts every config entry whose chain is tracked, matching the config's own fields including the underlying asset", async () => {
    const vaultIdByConfigKey = await syncVaultsFromConfig();

    const trackedSlugs = new Set((await db.select({ slug: chains.slug }).from(chains)).map((c) => c.slug));
    const expectedKeys = VERIFIED_VAULTS.filter((v) => trackedSlugs.has(v.chainSlug)).map((v) => v.key);

    for (const key of expectedKeys) {
      expect(vaultIdByConfigKey.has(key)).toBe(true);
    }

    const sample = VERIFIED_VAULTS.find((v) => trackedSlugs.has(v.chainSlug));
    if (!sample) return; // nothing to assert against if no config chain is tracked in this DB
    const vaultId = vaultIdByConfigKey.get(sample.key)!;

    const [row] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
    expect(row.configKey).toBe(sample.key);
    expect(row.address).toBe(sample.vaultAddress);
    expect(row.label).toBe(sample.label);
    expect(row.underlyingAddress).toBe(sample.underlyingAsset.address);
    expect(row.underlyingSymbol).toBe(sample.underlyingAsset.symbol);
    expect(row.underlyingDecimals).toBe(sample.underlyingAsset.decimals);
    expect(row.underlyingCoingeckoId).toBe(sample.underlyingAsset.coingeckoId);
  });

  it("is idempotent - running it twice does not create duplicate vault rows", async () => {
    // Scoped to VERIFIED_VAULTS' own keys, not a bare global count of the
    // whole table - this test runs concurrently with other test files
    // (e.g. lib/database/queries/vaults.test.ts, which inserts/deletes its
    // own synthetic vault rows via a real Postgres connection) under
    // vitest's default per-file parallelism, and an unscoped count can
    // observe an unrelated file's row appear or disappear mid-test. Scoping
    // by configKey makes this assertion depend only on what
    // syncVaultsFromConfig itself did, immune to that race.
    const countForRealVaults = async () => {
      const [row] = await db.select({ value: count() }).from(vaults).where(inArray(vaults.configKey, REAL_VAULT_KEYS));
      return row.value;
    };

    await syncVaultsFromConfig();
    const firstCount = await countForRealVaults();

    await syncVaultsFromConfig();
    const secondCount = await countForRealVaults();

    expect(secondCount).toBe(firstCount);
  });
});
