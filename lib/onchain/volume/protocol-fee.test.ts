// Pure unit tests for the protocol-revenue decision - no RPC. Covers both
// the both-boundaries-agree branches, including the "active" branch this
// phase's one real configured pool actually exercises live (factory.feeTo()
// == 0xf38521f130fcCF29dB1961597bc5d2B60F995f85, verified during this
// phase's own development - see config.ts's feeVerification comment), and
// the range-spanning-a-transition branch a purely current-head read could
// never detect.
import { describe, expect, it } from "vitest";
import {
  resolveProtocolRevenueForRange,
  resolveV3ProtocolRevenueForRange,
  type HistoricalFeeCheckResult,
  type HistoricalV3FeeCheckResult,
  type ProtocolFeeState,
  type V3ProtocolFeeState,
} from "./protocol-fee";

function feeState(overrides: Partial<ProtocolFeeState> = {}): ProtocolFeeState {
  return {
    factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    feeToAddress: "0x0000000000000000000000000000000000000000",
    active: false,
    ...overrides,
  };
}

describe("resolveProtocolRevenueForRange", () => {
  it("reports revenue as verifiably zero when feeTo() is the zero address at BOTH the start and end of the indexed range", () => {
    const check: HistoricalFeeCheckResult = {
      fromBlock: BigInt(100),
      toBlock: BigInt(200),
      fromBlockState: feeState({ active: false }),
      toBlockState: feeState({ active: false }),
    };
    const outcome = resolveProtocolRevenueForRange(check);
    expect(outcome).toEqual({
      available: true,
      revenueUsd: "0",
      reason: expect.stringContaining("BOTH the start (block 100) and end (block 200)"),
    });
  });

  it("reports revenue as unavailable (never fabricated as volume x a fraction) when feeTo() is active at both boundaries - the real, live state of this phase's one configured pool", () => {
    const active = feeState({ feeToAddress: "0xf38521f130fcCF29dB1961597bc5d2B60F995f85", active: true });
    const check: HistoricalFeeCheckResult = { fromBlock: BigInt(100), toBlock: BigInt(200), fromBlockState: active, toBlockState: active };
    const outcome = resolveProtocolRevenueForRange(check);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("Mint/Burn");
    expect((outcome as { revenueUsd?: string }).revenueUsd).toBeUndefined();
  });

  it("reports revenue as unavailable, never verified-zero, when feeTo() transitions from active to inactive within the indexed range", () => {
    // The exact scenario a current-head-only read could never catch: feeTo
    // active at the range's start, disabled somewhere before its end - the
    // whole range's revenue is genuinely unknown (not provably zero, since
    // it WAS active for at least part of it), not zero just because the
    // end of the range happens to read inactive.
    const check: HistoricalFeeCheckResult = {
      fromBlock: BigInt(100),
      toBlock: BigInt(200),
      fromBlockState: feeState({ active: true, feeToAddress: "0xf38521f130fcCF29dB1961597bc5d2B60F995f85" }),
      toBlockState: feeState({ active: false }),
    };
    const outcome = resolveProtocolRevenueForRange(check);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("state differs between the start");
    expect(outcome.reason).toContain("block 100, active");
    expect(outcome.reason).toContain("block 200, inactive");
  });

  it("reports revenue as unavailable when feeTo() transitions from inactive to active within the indexed range", () => {
    const check: HistoricalFeeCheckResult = {
      fromBlock: BigInt(100),
      toBlock: BigInt(200),
      fromBlockState: feeState({ active: false }),
      toBlockState: feeState({ active: true, feeToAddress: "0xf38521f130fcCF29dB1961597bc5d2B60F995f85" }),
    };
    const outcome = resolveProtocolRevenueForRange(check);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("state differs between the start");
  });

  it("never confuses an active-but-unmeasured mechanism with a genuinely zero one", () => {
    const inactiveCheck: HistoricalFeeCheckResult = {
      fromBlock: BigInt(1),
      toBlock: BigInt(2),
      fromBlockState: feeState({ active: false }),
      toBlockState: feeState({ active: false }),
    };
    const activeState = feeState({ active: true, feeToAddress: "0xabc" });
    const activeCheck: HistoricalFeeCheckResult = { fromBlock: BigInt(1), toBlock: BigInt(2), fromBlockState: activeState, toBlockState: activeState };

    expect(resolveProtocolRevenueForRange(inactiveCheck).available).toBe(true);
    expect(resolveProtocolRevenueForRange(activeCheck).available).toBe(false);
  });
});

// V3's own protocol-revenue decision - genuinely different mechanism
// (slot0().feeProtocol, read directly from the pool, not a factory-level
// switch) but the identical three-outcome shape, tested the same way.
function v3FeeState(overrides: Partial<V3ProtocolFeeState> = {}): V3ProtocolFeeState {
  return { poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", feeProtocol: 0, active: false, ...overrides };
}

describe("resolveV3ProtocolRevenueForRange", () => {
  it("reports revenue as verifiably zero when feeProtocol is 0 at BOTH the start and end of the indexed range", () => {
    const check: HistoricalV3FeeCheckResult = {
      fromBlock: BigInt(100),
      toBlock: BigInt(200),
      fromBlockState: v3FeeState({ feeProtocol: 0, active: false }),
      toBlockState: v3FeeState({ feeProtocol: 0, active: false }),
    };
    const outcome = resolveV3ProtocolRevenueForRange(check);
    expect(outcome).toEqual({
      available: true,
      revenueUsd: "0",
      reason: expect.stringContaining("BOTH the start (block 100) and end (block 200)"),
    });
  });

  it("reports revenue as unavailable when feeProtocol is active at both boundaries - the real, live state of this phase's one configured V3 pool (feeProtocol == 68)", () => {
    const active = v3FeeState({ feeProtocol: 68, active: true });
    const check: HistoricalV3FeeCheckResult = { fromBlock: BigInt(100), toBlock: BigInt(200), fromBlockState: active, toBlockState: active };
    const outcome = resolveV3ProtocolRevenueForRange(check);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("collectProtocol");
    expect((outcome as { revenueUsd?: string }).revenueUsd).toBeUndefined();
  });

  it("reports revenue as unavailable, never verified-zero, when feeProtocol transitions within the indexed range", () => {
    const check: HistoricalV3FeeCheckResult = {
      fromBlock: BigInt(100),
      toBlock: BigInt(200),
      fromBlockState: v3FeeState({ feeProtocol: 68, active: true }),
      toBlockState: v3FeeState({ feeProtocol: 0, active: false }),
    };
    const outcome = resolveV3ProtocolRevenueForRange(check);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("state differs between the start");
  });

  it("never confuses an active-but-unmeasured mechanism with a genuinely zero one", () => {
    const inactiveCheck: HistoricalV3FeeCheckResult = {
      fromBlock: BigInt(1),
      toBlock: BigInt(2),
      fromBlockState: v3FeeState({ feeProtocol: 0, active: false }),
      toBlockState: v3FeeState({ feeProtocol: 0, active: false }),
    };
    const activeState = v3FeeState({ feeProtocol: 68, active: true });
    const activeCheck: HistoricalV3FeeCheckResult = { fromBlock: BigInt(1), toBlock: BigInt(2), fromBlockState: activeState, toBlockState: activeState };

    expect(resolveV3ProtocolRevenueForRange(inactiveCheck).available).toBe(true);
    expect(resolveV3ProtocolRevenueForRange(activeCheck).available).toBe(false);
  });
});
