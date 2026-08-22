// Real-Postgres integration test for syncPoolsFromConfig - the Phase 4
// addition that makes VERIFIED_POOLS' human-curated entries queryable as
// real `pools`/`pool_tokens` rows, not just a TypeScript config array. Runs
// against the real VERIFIED_POOLS config (not synthetic data) since the
// thing under test is specifically "does the real config sync correctly,"
// and every chain/protocol it references already exists in the tracked
// database this test suite runs against.
import { count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, poolTokens, pools } from "@/lib/database/schema";
import { VERIFIED_POOLS } from "./config";
import { syncPoolsFromConfig } from "./pools";

// No afterEach cleanup: unlike this codebase's other integration tests,
// syncPoolsFromConfig's whole job is to populate `pools`/`pool_tokens` with
// the real, permanent canonical rows VERIFIED_POOLS describes - those rows
// are the intended production data, not disposable test fixtures, so
// leaving them in place after the test run matches what the real
// verification worker does too.
describe("syncPoolsFromConfig", () => {
  afterAll(async () => {
    await closeDb();
  });


  it("upserts every config entry whose chain is tracked, matching the config's own fields", async () => {
    const poolIdByConfigKey = await syncPoolsFromConfig();

    const trackedSlugs = new Set((await db.select({ slug: chains.slug }).from(chains)).map((c) => c.slug));
    const expectedKeys = VERIFIED_POOLS.filter((p) => trackedSlugs.has(p.chainSlug)).map((p) => p.key);

    for (const key of expectedKeys) {
      expect(poolIdByConfigKey.has(key)).toBe(true);
    }

    const sample = VERIFIED_POOLS.find((p) => trackedSlugs.has(p.chainSlug));
    if (!sample) return; // nothing to assert against if no config chain is tracked in this DB
    const poolId = poolIdByConfigKey.get(sample.key)!;

    const [row] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(row.configKey).toBe(sample.key);
    expect(row.address).toBe(sample.poolAddress);
    expect(row.label).toBe(sample.label);

    const tokenRows = await db
      .select()
      .from(poolTokens)
      .where(eq(poolTokens.poolId, poolId))
      .orderBy(poolTokens.position);
    expect(tokenRows).toHaveLength(sample.tokens.length);
    tokenRows.forEach((row, i) => {
      expect(row.address).toBe(sample.tokens[i].address);
      expect(row.symbol).toBe(sample.tokens[i].symbol);
      expect(row.decimals).toBe(sample.tokens[i].decimals);
      expect(row.coingeckoId).toBe(sample.tokens[i].coingeckoId);
      expect(row.position).toBe(i);
    });
  });

  it("is idempotent - running it twice does not create duplicate pool rows", async () => {
    await syncPoolsFromConfig();
    const [{ value: firstCount }] = await db.select({ value: count() }).from(pools);

    await syncPoolsFromConfig();
    const [{ value: secondCount }] = await db.select({ value: count() }).from(pools);

    expect(secondCount).toBe(firstCount);
  });
});
