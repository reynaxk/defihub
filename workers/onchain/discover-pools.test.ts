// Pure unit test for summarizeDiscoveryResults - no RPC, no DB.
import { describe, expect, it } from "vitest";
import type { DiscoveryRunResult } from "../../lib/onchain/discovery/engine";
import { summarizeDiscoveryResults } from "./discover-pools";

function success(overrides: Partial<DiscoveryRunResult> = {}): DiscoveryRunResult {
  return {
    deploymentKey: "test-deployment",
    ok: true,
    discovered: 5,
    validated: 3,
    activated: 2,
    rejected: 1,
    scanOutcome: "success",
    chunksCompleted: 1,
    ...overrides,
  };
}

function partialScan(overrides: Partial<DiscoveryRunResult> = {}): DiscoveryRunResult {
  return {
    deploymentKey: "test-deployment",
    ok: true,
    discovered: 2,
    validated: 0,
    activated: 0,
    rejected: 0,
    scanOutcome: "partial",
    chunksCompleted: 1,
    ...overrides,
  };
}

function failed(overrides: Partial<DiscoveryRunResult> = {}): DiscoveryRunResult {
  return { deploymentKey: "test-deployment", ok: false, error: "rpc down", discovered: 0, validated: 0, activated: 0, rejected: 0, ...overrides };
}

describe("summarizeDiscoveryResults", () => {
  it("reports success when every deployment's scan completed fully", () => {
    const summary = summarizeDiscoveryResults([success(), success()]);
    expect(summary).toEqual({ succeeded: 2, failed: 0, totalDiscovered: 10, totalActivated: 4, totalRejected: 2, outcome: "success" });
  });

  it("reports partial when a deployment's own scan only made partial catch-up progress", () => {
    const summary = summarizeDiscoveryResults([success(), partialScan()]);
    expect(summary.outcome).toBe("partial");
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it("reports partial (not failed) when one deployment fails outright but another succeeds - multi-deployment isolation", () => {
    const summary = summarizeDiscoveryResults([success(), failed()]);
    expect(summary.outcome).toBe("partial");
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("reports failed only when NOTHING succeeded anywhere", () => {
    const summary = summarizeDiscoveryResults([failed(), failed()]);
    expect(summary).toEqual({ succeeded: 0, failed: 2, totalDiscovered: 0, totalActivated: 0, totalRejected: 0, outcome: "failed" });
  });

  it("reports success for an empty result set (no deployments configured)", () => {
    expect(summarizeDiscoveryResults([])).toEqual({ succeeded: 0, failed: 0, totalDiscovered: 0, totalActivated: 0, totalRejected: 0, outcome: "success" });
  });

  it("sums discovered/activated/rejected across every deployment", () => {
    const summary = summarizeDiscoveryResults([success({ discovered: 10, activated: 5, rejected: 3 }), success({ discovered: 4, activated: 1, rejected: 0 })]);
    expect(summary.totalDiscovered).toBe(14);
    expect(summary.totalActivated).toBe(6);
    expect(summary.totalRejected).toBe(3);
  });
});
