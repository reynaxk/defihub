// Real-Postgres integration test for the apyLessThan fix (CodeRabbit
// finding: "getYieldPools query still includes pools where apy ===
// HIGH_RISK_APY"). getYieldPools sorts apy-desc and caps at
// UNPAGED_MAX_ROWS (2000) - the research engine's answerAttractiveYields
// relies on the database predicate itself to exclude
// apy >= HIGH_RISK_APY, not a post-fetch filter, precisely because enough
// pools sitting *at* the threshold can otherwise fill the entire 2000-row
// window before a genuinely eligible, lower-APY pool is ever returned.
// This seeds exactly that scenario: 2000 pools at the exact boundary value,
// plus one eligible pool ranked below all of them by raw APY.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, yieldPools } from "@/lib/database/schema";
import { getYieldPools } from "./yields";

const HIGH_RISK_APY = 1000;
const BOUNDARY_POOL_COUNT = 2000;
const ELIGIBLE_APY = 50;
const TVL_ABOVE_MIN = "500000";

describe("getYieldPools apyLessThan", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("excludes pools at exactly the boundary APY even when 2000+ of them outrank the eligible pool", async () => {
    const [chain] = await db
      .insert(chains)
      .values({ name: `Test Chain ${randomUUID()}`, slug: `test-chain-${randomUUID()}`, nativeToken: "TST" })
      .returning({ id: chains.id, slug: chains.slug });
    createdChainIds.push(chain.id);

    const eligibleExternalId = `eligible-${randomUUID()}`;
    const boundaryRows = Array.from({ length: BOUNDARY_POOL_COUNT }, (_, i) => ({
      externalPoolId: `boundary-${i}-${randomUUID()}`,
      chainId: chain.id,
      symbol: "BOUNDARY",
      apy: HIGH_RISK_APY.toString(),
      tvlUsd: TVL_ABOVE_MIN,
    }));

    await db.insert(yieldPools).values([
      ...boundaryRows,
      {
        externalPoolId: eligibleExternalId,
        chainId: chain.id,
        symbol: "ELIGIBLE",
        apy: ELIGIBLE_APY.toString(),
        tvlUsd: TVL_ABOVE_MIN,
      },
    ]);

    const results = await getYieldPools({
      chainSlug: chain.slug,
      sortBy: "apy",
      sortDir: "desc",
      minTvl: Number(TVL_ABOVE_MIN) - 1,
      apyLessThan: HIGH_RISK_APY,
    });

    // The fix: none of the 2000 at-boundary pools count against the
    // fetch limit at all, so the eligible pool is actually returned.
    const eligible = results.find((p) => p.symbol === "ELIGIBLE");
    expect(eligible).toBeDefined();
    expect(eligible?.apy).toBe(ELIGIBLE_APY);

    // No pool at or above the threshold should ever come back.
    expect(results.every((p) => p.apy == null || p.apy < HIGH_RISK_APY)).toBe(true);
  });
});
