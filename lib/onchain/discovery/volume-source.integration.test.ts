// Real-Postgres integration test for getAllVolumeSourcePools - proves an
// "active" discovered pool is genuinely mapped into the exact
// VolumeSourcePool shape indexAllPoolVolume/recheckVolumeReorgs already
// consume, alongside every config-curated pool unchanged.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, discoveredPools } from "@/lib/database/schema";
import { VOLUME_SOURCE_POOLS } from "../volume/config";
import type { FactoryDeployment } from "./config";
import { markDiscoveredPoolActive, recordDiscoveredPools } from "./queries";
import { registerDiscoveredPoolAsPool } from "./register";

describe("getAllVolumeSourcePools", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
    vi.doUnmock("./config");
    vi.resetModules();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("always includes every config-curated VOLUME_SOURCE_POOLS entry unchanged", async () => {
    const { getAllVolumeSourcePools } = await import("./volume-source");
    const all = await getAllVolumeSourcePools();
    for (const configPool of VOLUME_SOURCE_POOLS) {
      expect(all).toContainEqual(configPool);
    }
  });

  it("includes a genuinely active discovered pool, mapped with the deployment's own feeBps/sourceKind/factoryAddress and the pool's real creation block as startBlock", async () => {
    const chainSlug = `volume-source-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: "Volume Source Test Chain", slug: chainSlug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const deployment: FactoryDeployment = {
      key: `vs-test-${randomUUID()}`,
      chainSlug,
      protocolDefillamaSlug: "test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0xtestfactory",
      feeBps: 17, // a deliberately distinctive, unmistakable value
      startBlock: BigInt(1),
    };

    // Isolates this test from the real FACTORY_DEPLOYMENTS list - proves
    // the mapping logic itself, not dependent on today's real config
    // entries staying exactly as they are.
    vi.doMock("./config", () => ({ FACTORY_DEPLOYMENTS: [deployment] }));
    vi.resetModules();

    const poolAddress = `0xvstest${randomUUID().slice(0, 8)}`;
    await recordDiscoveredPools(chain.id, deployment, [
      {
        token0: "0xtoken0vs",
        token1: "0xtoken1vs",
        poolAddress,
        blockNumber: BigInt(999999),
        blockHash: "0x" + "cc".repeat(32),
        transactionHash: "0x" + "dd".repeat(32),
        logIndex: 1,
      },
    ]);
    const [row] = await db.select({ id: discoveredPools.id }).from(discoveredPools).where(eq(discoveredPools.poolAddress, poolAddress));

    const poolId = await registerDiscoveredPoolAsPool(chain.id, null, deployment, poolAddress, { address: "0xtoken0vs", symbol: "VS0", decimals: 18 }, {
      address: "0xtoken1vs",
      symbol: "VS1",
      decimals: 6,
    });
    await markDiscoveredPoolActive(row.id, 18, 6, poolId);

    const { getAllVolumeSourcePools } = await import("./volume-source");
    const all = await getAllVolumeSourcePools();
    const found = all.find((p) => p.poolAddress === poolAddress);

    expect(found).toBeDefined();
    expect(found).toMatchObject({
      chainSlug,
      sourceKind: "uniswap-v2",
      factoryAddress: "0xtestfactory",
      feeBps: 17,
      startBlock: BigInt(999999),
      token0: { address: "0xtoken0vs", decimals: 18 },
      token1: { address: "0xtoken1vs", decimals: 6 },
    });
  });
});
