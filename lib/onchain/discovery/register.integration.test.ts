// Real-Postgres integration tests for registerDiscoveredPoolAsPool - the
// bridge from a validated discovered pool into the SAME pools/pool_tokens
// tables config-curated pools already use.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, pools, poolTokens } from "@/lib/database/schema";
import type { FactoryDeployment } from "./config";
import { discoveredPoolConfigKey, registerDiscoveredPoolAsPool } from "./register";

describe("registerDiscoveredPoolAsPool", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<{ id: string; slug: string }> {
    const slug = `register-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: `Register Test Chain ${randomUUID()}`, slug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return { id: chain.id, slug };
  }

  function deployment(chainSlug: string): FactoryDeployment {
    return {
      key: "test-deployment",
      chainSlug,
      protocolDefillamaSlug: "test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0xfactory",
      feeBps: 30,
      startBlock: BigInt(1),
    };
  }

  it("creates a real pools row with the deterministic discovered: configKey, plus 2 ordered pool_tokens rows", async () => {
    const chain = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;

    const poolId = await registerDiscoveredPoolAsPool(
      chain.id,
      null,
      deployment(chain.slug),
      poolAddress,
      { address: "0xtoken0", symbol: "TOK0", decimals: 18 },
      { address: "0xtoken1", symbol: "TOK1", decimals: 6 },
    );

    const [poolRow] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(poolRow.configKey).toBe(discoveredPoolConfigKey(chain.slug, poolAddress));
    expect(poolRow.address).toBe(poolAddress.toLowerCase());
    expect(poolRow.label).toContain("TOK0");
    expect(poolRow.label).toContain("TOK1");

    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, poolId)).orderBy(poolTokens.position);
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows[0]).toMatchObject({ address: "0xtoken0", symbol: "TOK0", decimals: 18, position: 0 });
    expect(tokenRows[1]).toMatchObject({ address: "0xtoken1", symbol: "TOK1", decimals: 6, position: 1 });
  });

  it("falls back to a truncated-address label when symbol is unresolved, never fabricating a plausible-looking symbol", async () => {
    const chain = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;

    const poolId = await registerDiscoveredPoolAsPool(chain.id, null, deployment(chain.slug), poolAddress, { address: "0xaaaaaaaa", symbol: null, decimals: 18 }, {
      address: "0xbbbbbbbb",
      symbol: null,
      decimals: 18,
    });

    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, poolId)).orderBy(poolTokens.position);
    expect(tokenRows[0].symbol).toBe("UNKNOWN");
    expect(tokenRows[1].symbol).toBe("UNKNOWN");
  });

  it("IDEMPOTENT: re-registering the same pool address upserts rather than creating a duplicate pools row", async () => {
    const chain = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;
    const dep = deployment(chain.slug);

    const firstId = await registerDiscoveredPoolAsPool(chain.id, null, dep, poolAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });
    const secondId = await registerDiscoveredPoolAsPool(chain.id, null, dep, poolAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });

    expect(secondId).toBe(firstId);
    const allRows = await db.select().from(pools).where(eq(pools.chainId, chain.id));
    expect(allRows).toHaveLength(1);
    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, firstId));
    expect(tokenRows).toHaveLength(2); // not duplicated by the re-registration's delete+reinsert
  });

  it("CASE-INSENSITIVE: registering a lowercase address, then the same address with mixed casing, is treated as the SAME pool - no duplicate rows", async () => {
    const chain = await makeChain();
    const lowercaseAddress = `0xpool${randomUUID().slice(0, 8)}`.toLowerCase();
    const mixedCaseAddress = "0xPOOL" + lowercaseAddress.slice(6); // same bytes, different letter casing

    const dep = deployment(chain.slug);
    const firstId = await registerDiscoveredPoolAsPool(chain.id, null, dep, lowercaseAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });
    const secondId = await registerDiscoveredPoolAsPool(chain.id, null, dep, mixedCaseAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });

    expect(secondId).toBe(firstId);
    const allRows = await db.select().from(pools).where(eq(pools.chainId, chain.id));
    expect(allRows).toHaveLength(1);
    expect(allRows[0].address).toBe(lowercaseAddress); // always stored normalized
    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, firstId));
    expect(tokenRows).toHaveLength(2);
  });

  it("CURATED-POOL PROTECTION: never overwrites an existing curated (non-discovery) pool's label/protocolId, and never touches its pool_tokens - discovery recognizes it as already-tracked instead", async () => {
    const chain = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`.toLowerCase();

    // Simulate a hand-curated VERIFIED_POOLS row already tracked at this
    // exact (chainId, address) - configKey deliberately does NOT start
    // with "discovered:", matching syncPoolsFromConfig's own real
    // convention (lib/onchain/pools.ts).
    const curatedConfigKey = `curated-test-pool-${randomUUID()}`;
    const [curatedPool] = await db
      .insert(pools)
      .values({ configKey: curatedConfigKey, chainId: chain.id, label: "USDC/WETH (Curated, Hand-Verified)", address: poolAddress })
      .returning({ id: pools.id });
    await db.insert(poolTokens).values([
      { poolId: curatedPool.id, address: "0xusdc", symbol: "USDC", decimals: 6, coingeckoId: "usd-coin", position: 0 },
      { poolId: curatedPool.id, address: "0xweth", symbol: "WETH", decimals: 18, coingeckoId: "weth", position: 1 },
    ]);

    // Discovery later finds a PairCreated event for this SAME real address
    // under a totally different deployment/token-metadata guess.
    const returnedId = await registerDiscoveredPoolAsPool(
      chain.id,
      null,
      deployment(chain.slug),
      poolAddress,
      { address: "0xdifferenttoken0", symbol: "WRONG0", decimals: 18 },
      { address: "0xdifferenttoken1", symbol: "WRONG1", decimals: 18 },
    );

    expect(returnedId).toBe(curatedPool.id);

    const [poolRowAfter] = await db.select().from(pools).where(eq(pools.id, curatedPool.id));
    expect(poolRowAfter.configKey).toBe(curatedConfigKey); // still the curated key, never rewritten to a "discovered:" one
    expect(poolRowAfter.label).toBe("USDC/WETH (Curated, Hand-Verified)"); // never overwritten with a discovery-generated label

    const tokenRowsAfter = await db.select().from(poolTokens).where(eq(poolTokens.poolId, curatedPool.id)).orderBy(poolTokens.position);
    expect(tokenRowsAfter).toHaveLength(2);
    expect(tokenRowsAfter[0]).toMatchObject({ address: "0xusdc", symbol: "USDC", coingeckoId: "usd-coin" }); // real coingeckoId preserved, never reset to null
    expect(tokenRowsAfter[1]).toMatchObject({ address: "0xweth", symbol: "WETH", coingeckoId: "weth" });

    // No second pools row was created for the same (chainId, address).
    const allRows = await db.select().from(pools).where(eq(pools.chainId, chain.id));
    expect(allRows).toHaveLength(1);
  });

  it("CROSS-CHAIN: registering the exact same pool address on two DIFFERENT chains succeeds for both - configKey's chain discriminator prevents a collision on that GLOBAL unique column", async () => {
    const chainA = await makeChain();
    const chainB = await makeChain();
    const sharedAddress = `0xpool${randomUUID().slice(0, 8)}`.toLowerCase(); // same real 20-byte address, hypothetically discovered on two chains

    const idOnA = await registerDiscoveredPoolAsPool(chainA.id, null, deployment(chainA.slug), sharedAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 18,
    });
    const idOnB = await registerDiscoveredPoolAsPool(chainB.id, null, deployment(chainB.slug), sharedAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 18,
    });

    expect(idOnA).not.toBe(idOnB); // two genuinely distinct pools, not silently merged
    const [rowA] = await db.select().from(pools).where(eq(pools.id, idOnA));
    const [rowB] = await db.select().from(pools).where(eq(pools.id, idOnB));
    expect(rowA.configKey).toBe(discoveredPoolConfigKey(chainA.slug, sharedAddress));
    expect(rowB.configKey).toBe(discoveredPoolConfigKey(chainB.slug, sharedAddress));
    expect(rowA.configKey).not.toBe(rowB.configKey); // the chain discriminator is what keeps these apart on the global unique configKey column
  });
});
