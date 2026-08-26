// Pure unit test for the static half of the coverage registry - no DB.
// getVolumeCoverage (the live-query half) is exercised indirectly through
// lib/onchain/volume's own integration tests (getPoolIdByConfigKey,
// getLatestVolumeObservation) - re-testing the same queries a third time
// through this thin wrapper would not add coverage.
import { describe, expect, it } from "vitest";
import { getStaticCoverage } from "./coverage";
import { REFERENCE_ASSETS } from "./pricing/config";
import { VERIFIED_POOLS, VERIFIED_VAULTS } from "./config";

describe("getStaticCoverage", () => {
  it("reports exactly one NATIVE tvl_usd entry per configured pool and vault", () => {
    const entries = getStaticCoverage();
    const tvlEntries = entries.filter((e) => e.metric === "tvl_usd");
    expect(tvlEntries).toHaveLength(VERIFIED_POOLS.length + VERIFIED_VAULTS.length);
    expect(tvlEntries.every((e) => e.source === "NATIVE")).toBe(true);
  });

  it("reports exactly one NATIVE price_usd entry per configured reference asset", () => {
    const entries = getStaticCoverage();
    const priceEntries = entries.filter((e) => e.metric === "price_usd");
    expect(priceEntries).toHaveLength(REFERENCE_ASSETS.length);
    expect(priceEntries.every((e) => e.source === "NATIVE")).toBe(true);
  });

  it("never fabricates coverage beyond what config actually declares", () => {
    const entries = getStaticCoverage();
    const total = VERIFIED_POOLS.length + VERIFIED_VAULTS.length + REFERENCE_ASSETS.length;
    expect(entries).toHaveLength(total);
  });
});
