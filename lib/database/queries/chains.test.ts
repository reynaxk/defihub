// Real-Postgres integration test for getChainProtocolCounts. The thing
// under test: it must report a chain's true protocol-association count via
// a real COUNT(*), not the capped slice getChainBySlug's own `topProtocols`
// returns (limit(50) - see that function) - a chain with more real
// associations than that cap would otherwise silently under-report on the
// chain detail page's "Protocols" metric.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, protocolChains, protocols } from "@/lib/database/schema";
import { getChainProtocolCounts } from "./chains";

const OVER_CAP_COUNT = 55;

describe("getChainProtocolCounts", () => {
  const createdChainIds: string[] = [];
  const createdProtocolIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
    if (createdProtocolIds.length > 0) {
      await db.delete(protocols).where(inArray(protocols.id, createdProtocolIds.splice(0)));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reports the true count for a chain with more than 50 protocol associations, not the 50-row cap getChainBySlug's topProtocols uses", async () => {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const protocolRows = await db
      .insert(protocols)
      .values(
        Array.from({ length: OVER_CAP_COUNT }, (_, i) => ({
          name: `Test Protocol ${i} ${randomUUID()}`,
          slug: `test-protocol-${i}-${randomUUID()}`,
        })),
      )
      .returning({ id: protocols.id });
    createdProtocolIds.push(...protocolRows.map((p) => p.id));

    await db
      .insert(protocolChains)
      .values(protocolRows.map((p) => ({ protocolId: p.id, chainId: chain.id })));

    const counts = await getChainProtocolCounts([chain.id]);
    expect(counts.get(chain.id)).toBe(OVER_CAP_COUNT);
    // The bug this guards against: silently reporting the cap instead of
    // the real count.
    expect(counts.get(chain.id)).toBeGreaterThan(50);
  });

  it("returns an empty map for an empty chainIds array without querying", async () => {
    const counts = await getChainProtocolCounts([]);
    expect(counts.size).toBe(0);
  });
});
