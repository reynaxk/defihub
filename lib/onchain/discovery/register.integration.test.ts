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

  async function makeChain(): Promise<string> {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Register Test Chain ${randomUUID()}`, slug: `register-test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return chain.id;
  }

  function deployment(): FactoryDeployment {
    return {
      key: "test-deployment",
      chainSlug: "test-chain",
      protocolDefillamaSlug: "test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0xfactory",
      feeBps: 30,
      startBlock: BigInt(1),
    };
  }

  it("creates a real pools row with the deterministic discovered: configKey, plus 2 ordered pool_tokens rows", async () => {
    const chainId = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;

    const poolId = await registerDiscoveredPoolAsPool(
      chainId,
      null,
      deployment(),
      poolAddress,
      { address: "0xtoken0", symbol: "TOK0", decimals: 18 },
      { address: "0xtoken1", symbol: "TOK1", decimals: 6 },
    );

    const [poolRow] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(poolRow.configKey).toBe(discoveredPoolConfigKey(poolAddress));
    expect(poolRow.address).toBe(poolAddress);
    expect(poolRow.label).toContain("TOK0");
    expect(poolRow.label).toContain("TOK1");

    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, poolId)).orderBy(poolTokens.position);
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows[0]).toMatchObject({ address: "0xtoken0", symbol: "TOK0", decimals: 18, position: 0 });
    expect(tokenRows[1]).toMatchObject({ address: "0xtoken1", symbol: "TOK1", decimals: 6, position: 1 });
  });

  it("falls back to a truncated-address label when symbol is unresolved, never fabricating a plausible-looking symbol", async () => {
    const chainId = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;

    const poolId = await registerDiscoveredPoolAsPool(chainId, null, deployment(), poolAddress, { address: "0xaaaaaaaa", symbol: null, decimals: 18 }, {
      address: "0xbbbbbbbb",
      symbol: null,
      decimals: 18,
    });

    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, poolId)).orderBy(poolTokens.position);
    expect(tokenRows[0].symbol).toBe("UNKNOWN");
    expect(tokenRows[1].symbol).toBe("UNKNOWN");
  });

  it("IDEMPOTENT: re-registering the same pool address upserts rather than creating a duplicate pools row", async () => {
    const chainId = await makeChain();
    const poolAddress = `0xpool${randomUUID().slice(0, 8)}`;
    const dep = deployment();

    const firstId = await registerDiscoveredPoolAsPool(chainId, null, dep, poolAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });
    const secondId = await registerDiscoveredPoolAsPool(chainId, null, dep, poolAddress, { address: "0xtoken0", symbol: "TOK0", decimals: 18 }, {
      address: "0xtoken1",
      symbol: "TOK1",
      decimals: 6,
    });

    expect(secondId).toBe(firstId);
    const allRows = await db.select().from(pools).where(eq(pools.chainId, chainId));
    expect(allRows).toHaveLength(1);
    const tokenRows = await db.select().from(poolTokens).where(eq(poolTokens.poolId, firstId));
    expect(tokenRows).toHaveLength(2); // not duplicated by the re-registration's delete+reinsert
  });
});
