// Real-Postgres integration test for the protocol_metrics_unique_aggregate_snapshot
// partial index added in migration 0022. Before that migration, Postgres's
// default NULLS DISTINCT behavior meant two aggregate (chain_id IS NULL) rows
// sharing the same (protocol_id, timestamp) were never rejected as a
// conflict, so workers/protocols/sync.ts's onConflictDoNothing() silently
// never engaged for them - this proves it now does, against the live schema,
// not just by reading the index definition.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "./client";
import { chains, protocolMetrics, protocols } from "./schema";

describe("protocol_metrics unique constraints", () => {
  const createdProtocolIds: string[] = [];
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdProtocolIds.splice(0)) await db.delete(protocols).where(eq(protocols.id, id));
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("rejects a duplicate aggregate (chain_id IS NULL) snapshot as a conflict, keeping exactly one row", async () => {
    const [protocol] = await db
      .insert(protocols)
      .values({ name: `Test ${randomUUID()}`, slug: `test-${randomUUID()}` })
      .returning({ id: protocols.id });
    createdProtocolIds.push(protocol.id);

    const timestamp = new Date();
    await db
      .insert(protocolMetrics)
      .values([
        { protocolId: protocol.id, chainId: null, timestamp, tvl: "100.00" },
        { protocolId: protocol.id, chainId: null, timestamp, tvl: "100.00" },
      ])
      .onConflictDoNothing();

    const rows = await db.select().from(protocolMetrics).where(eq(protocolMetrics.protocolId, protocol.id));
    expect(rows).toHaveLength(1);
  });

  it("still rejects a duplicate per-chain snapshot as a conflict (the pre-existing composite index)", async () => {
    const [protocol] = await db
      .insert(protocols)
      .values({ name: `Test ${randomUUID()}`, slug: `test-${randomUUID()}` })
      .returning({ id: protocols.id });
    createdProtocolIds.push(protocol.id);
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test ${randomUUID()}`, slug: `test-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id });
    createdChainIds.push(chain.id);

    const timestamp = new Date();
    await db
      .insert(protocolMetrics)
      .values([
        { protocolId: protocol.id, chainId: chain.id, timestamp, tvl: "50.00" },
        { protocolId: protocol.id, chainId: chain.id, timestamp, tvl: "50.00" },
      ])
      .onConflictDoNothing();

    const rows = await db.select().from(protocolMetrics).where(eq(protocolMetrics.protocolId, protocol.id));
    expect(rows).toHaveLength(1);
  });
});
