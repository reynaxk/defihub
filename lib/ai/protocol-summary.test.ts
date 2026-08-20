// Real-Postgres integration tests, same reasoning as
// lib/security/rate-limit.test.ts: getCachedProtocolSummary's staleness
// logic is a real correctness concern (does a cached summary get correctly
// invalidated when the underlying TVL has moved enough to make it
// misleading?), not something worth re-deriving behind a mock of the DB
// query it actually runs. Only getCachedProtocolSummary is covered here,
// not generateProtocolSummary (which calls the real Anthropic API) or
// buildPrompt (no DB dependency, but also not part of this fix).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { protocolAiSummaries, protocols } from "@/lib/database/schema";
import { getCachedProtocolSummary } from "./protocol-summary";

async function seedRawSummary(content: string, tvlAtGeneration: number | null) {
  const [protocol] = await db
    .insert(protocols)
    .values({ name: `Test Protocol ${randomUUID()}`, slug: `test-protocol-${randomUUID()}` })
    .returning({ id: protocols.id });

  await db.insert(protocolAiSummaries).values({
    protocolId: protocol.id,
    content,
    model: "test-model",
    tvlAtGeneration: tvlAtGeneration != null ? tvlAtGeneration.toFixed(2) : null,
  });

  return protocol.id;
}

function seedSummary(tvlAtGeneration: number | null) {
  return seedRawSummary(
    JSON.stringify({ overview: "A test summary.", insights: [], risks: [], opportunities: [] }),
    tvlAtGeneration,
  );
}

describe("getCachedProtocolSummary", () => {
  const createdProtocolIds: string[] = [];

  afterEach(async () => {
    // protocolAiSummaries.protocolId cascades on delete, so removing the
    // protocol row cleans up both tables in one statement per test.
    for (const id of createdProtocolIds.splice(0)) {
      await db.delete(protocols).where(eq(protocols.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns null when no summary is cached", async () => {
    const result = await getCachedProtocolSummary(randomUUID(), 1_000_000);
    expect(result).toBeNull();
  });

  it("serves the cached summary as-is when tvlAtGeneration is null (unknown baseline)", async () => {
    const id = await seedSummary(null);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 1_000_000);
    expect(result).not.toBeNull();
    expect(result?.sections.overview).toBe("A test summary.");
  });

  it("stays fresh when the TVL baseline was zero and current TVL is still zero", async () => {
    const id = await seedSummary(0);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 0);
    expect(result).not.toBeNull();
  });

  it("goes stale when the TVL baseline rounded to zero but current TVL is now measurable", async () => {
    // Regression test for the numeric(24,2)-column edge case: a summary
    // generated while TVL was sub-cent (e.g. $0.003) is stored as exactly
    // 0.00 by the column itself, which the old `tvlAtGeneration !== 0`
    // guard treated the same as "unknown" and never invalidated. This
    // covers the fixed behavior: any nonzero current TVL now correctly
    // invalidates a zero-baseline summary instead of leaving it fresh
    // forever.
    const id = await seedSummary(0);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 500_000);
    expect(result).toBeNull();
  });

  it("stays fresh under the 25% staleness threshold", async () => {
    const id = await seedSummary(1_000_000);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 1_200_000); // +20%
    expect(result).not.toBeNull();
  });

  it("goes stale at or above the 25% staleness threshold", async () => {
    const id = await seedSummary(1_000_000);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 1_300_000); // +30%
    expect(result).toBeNull();
  });

  it("serves the cached summary as-is when currentTvl is null (unknown current value)", async () => {
    const id = await seedSummary(1_000_000);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, null);
    expect(result).not.toBeNull();
  });

  it("treats legacy plain-text content (pre structured-output) as a cache miss instead of crashing", async () => {
    // Regression test: rows written before the Phase 7 structured-output
    // migration store plain prose in `content`, not JSON. JSON.parse on
    // that string throws - this must be caught and treated as "nothing
    // usable cached" (triggering regeneration), never propagate and take
    // down the protocol page.
    const id = await seedRawSummary(
      "Aave is a decentralized lending protocol with roughly $10B in TVL.",
      1_000_000,
    );
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 1_000_000);
    expect(result).toBeNull();
  });

  it("treats valid JSON that doesn't match the summary schema as a cache miss instead of crashing", async () => {
    const id = await seedRawSummary(JSON.stringify({ unexpected: "shape" }), 1_000_000);
    createdProtocolIds.push(id);

    const result = await getCachedProtocolSummary(id, 1_000_000);
    expect(result).toBeNull();
  });
});
