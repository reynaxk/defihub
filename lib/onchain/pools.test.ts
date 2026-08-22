// Real-Postgres integration test for syncPoolsFromConfig - the Phase 4
// addition that makes VERIFIED_POOLS' human-curated entries queryable as
// real `pools`/`pool_tokens` rows, not just a TypeScript config array. Runs
// against the real VERIFIED_POOLS config (not synthetic data) since the
// thing under test is specifically "does the real config sync correctly,"
// and every chain/protocol it references already exists in the tracked
// database this test suite runs against.
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, poolTokens, pools } from "@/lib/database/schema";
import { VERIFIED_POOLS, type VerifiedPool } from "./config";
import { syncPoolsFromConfig } from "./pools";

// No afterEach cleanup: unlike this codebase's other integration tests,
// syncPoolsFromConfig's whole job is to populate `pools`/`pool_tokens` with
// the real, permanent canonical rows VERIFIED_POOLS describes - those rows
// are the intended production data, not disposable test fixtures, so
// leaving them in place after the test run matches what the real
// verification worker does too.
describe("syncPoolsFromConfig", () => {
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

// Separate describe block, its own synthetic (disposable) chain + pool, and
// its own afterEach cleanup - unlike the block above, this one isn't
// exercising the real VERIFIED_POOLS config, so nothing here belongs in
// the database once the test finishes.
describe("syncPoolsFromConfig transaction atomicity", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("rolls back the whole sync when the token reinsert fails, leaving the previous token set unchanged", async () => {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Atomicity Test Chain ${randomUUID()}`, slug: `atomicity-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id, slug: chains.slug });
    createdChainIds.push(chain.id);

    const configKey = `atomicity-test-pool-${randomUUID()}`;
    const goodPool: VerifiedPool = {
      key: configKey,
      chainSlug: chain.slug,
      protocolDefillamaSlug: "does-not-exist",
      label: "Atomicity test pool",
      poolAddress: `0xpool${randomUUID().slice(0, 8)}`,
      tokens: [
        { address: "0xaaa", symbol: "AAA", decimals: 18, coingeckoId: "aaa" },
        { address: "0xbbb", symbol: "BBB", decimals: 18, coingeckoId: "bbb" },
      ],
    };

    const firstRun = await syncPoolsFromConfig([goodPool]);
    const poolId = firstRun.get(configKey);
    expect(poolId).toBeDefined();

    const beforeTokens = await db
      .select()
      .from(poolTokens)
      .where(eq(poolTokens.poolId, poolId!))
      .orderBy(poolTokens.position);
    expect(beforeTokens.map((t) => t.symbol)).toEqual(["AAA", "BBB"]);

    // A symbol longer than pool_tokens.symbol's varchar(32) limit makes
    // the reinsert fail partway through the transaction - deterministic,
    // no need to fight the schema's own unique constraints to trigger it.
    const brokenPool: VerifiedPool = {
      ...goodPool,
      label: "SHOULD NOT PERSIST - this update must roll back with the failed token insert",
      tokens: [
        { address: "0xccc", symbol: "CCC", decimals: 18, coingeckoId: "ccc" },
        { address: "0xddd", symbol: "D".repeat(64), decimals: 18, coingeckoId: "ddd" },
      ],
    };

    await expect(syncPoolsFromConfig([brokenPool])).rejects.toThrow();

    const afterTokens = await db
      .select()
      .from(poolTokens)
      .where(eq(poolTokens.poolId, poolId!))
      .orderBy(poolTokens.position);
    expect(afterTokens.map((t) => t.symbol)).toEqual(["AAA", "BBB"]);

    // The pool row's own fields must also be untouched - the upsert inside
    // the same failed transaction rolls back too, not just the tokens.
    const [poolRow] = await db.select().from(pools).where(eq(pools.id, poolId!));
    expect(poolRow.label).toBe("Atomicity test pool");
  });
});
