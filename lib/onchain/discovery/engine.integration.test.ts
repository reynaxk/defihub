// Real-Postgres integration test for discoverAllPools's multi-deployment
// isolation (Section 26/27) - a broken deployment must not prevent the
// loop from reaching/reporting on the next one. Deliberately scoped to the
// deterministic, RPC-free early-exit path (chain not found in the DB),
// mirroring lib/onchain/volume/engine.integration.test.ts's own exact
// convention: engine-level orchestration is not unit-tested directly,
// only its extracted pure decision functions are (see validate.test.ts's
// resolveValidationOutcome coverage) - this exercises real isolation
// behavior without needing a live/mocked chain call.
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/database/client";
import type { FactoryDeployment } from "./config";
import { discoverAllPools } from "./engine";

function unresolvableDeployment(key: string): FactoryDeployment {
  return {
    key,
    chainSlug: `nonexistent-chain-${key}`,
    protocolDefillamaSlug: "test-protocol",
    dexKind: "uniswap-v2",
    factoryAddress: "0xfactory",
    feeBps: 30,
    startBlock: BigInt(1),
  };
}

describe("discoverAllPools - multi-deployment isolation", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("continues to the next deployment after an earlier one fails - both failures are reported, not just the first", async () => {
    const depA = unresolvableDeployment("isolation-test-dep-a");
    const depB = unresolvableDeployment("isolation-test-dep-b");

    const results = await discoverAllPools([depA, depB]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ deploymentKey: depA.key, ok: false, discovered: 0, activated: 0, rejected: 0 });
    expect(results[1]).toMatchObject({ deploymentKey: depB.key, ok: false, discovered: 0, activated: 0, rejected: 0 });
    // Each deployment's own error message names its own chain - proves
    // depB was actually attempted with its own identity, not skipped or a
    // copy of depA's failure.
    expect(results[0].error).toContain(depA.chainSlug);
    expect(results[1].error).toContain(depB.chainSlug);
  });

  it("returns an empty result set for an empty deployment list, never erroring", async () => {
    expect(await discoverAllPools([])).toEqual([]);
  });
});
