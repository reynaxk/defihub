// Pure unit tests for the protocol-revenue decision - no RPC. Covers both
// the both-boundaries-agree branches, including the "active" branch this
// phase's one real configured pool actually exercises live (factory.feeTo()
// == 0xf38521f130fcCF29dB1961597bc5d2B60F995f85, verified during this
// phase's own development - see config.ts's feeVerification comment), and
// the range-spanning-a-transition branch a purely current-head read could
// never detect.
import type { Log } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeSetFeeProtocolLog,
  reconstructV3FeeProtocolSegments,
  resolveProtocolRevenueForRange,
  resolveV3ProtocolRevenueFromSegments,
  type HistoricalFeeCheckResult,
  type ProtocolFeeState,
  type V3FeeProtocolSegment,
  type V3FeeProtocolTransitionEvent,
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
// switch), and now (PR #14 follow-up) reconstructed from real
// SetFeeProtocol transition events across the WHOLE indexed range rather
// than trusted from just its two boundary reads - see protocol-fee.ts's own
// "Historical-transition bug fix" module comment for the exact bug this
// replaced.
function v3FeeState(overrides: Partial<V3ProtocolFeeState> = {}): V3ProtocolFeeState {
  return { poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", feeProtocol: 0, active: false, ...overrides };
}

function transition(overrides: Partial<V3FeeProtocolTransitionEvent> = {}): V3FeeProtocolTransitionEvent {
  return { blockNumber: BigInt(150), logIndex: 0, feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 0, feeProtocol1New: 0, ...overrides };
}

describe("decodeSetFeeProtocolLog", () => {
  const RAW = {
    address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    blockNumber: BigInt(150),
    blockHash: "0x" + "aa".repeat(32),
    transactionHash: "0x" + "bb".repeat(32),
    logIndex: 3,
    args: { feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 },
  };

  it("decodes a well-formed SetFeeProtocol log exactly, matching viem's real uint8-as-number decode behavior", () => {
    const decoded = decodeSetFeeProtocolLog(RAW as unknown as Log);
    expect(decoded).toEqual({ blockNumber: BigInt(150), logIndex: 3, feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 });
  });

  it("returns null when block identity is missing (a pending/unmined log)", () => {
    const pending = { ...RAW, blockNumber: null, logIndex: null } as unknown as Log;
    expect(decodeSetFeeProtocolLog(pending)).toBeNull();
  });

  it("returns null when args are missing entirely", () => {
    const noArgs = { ...RAW, args: undefined } as unknown as Log;
    expect(decodeSetFeeProtocolLog(noArgs)).toBeNull();
  });

  it("returns null when a feeProtocol field has the wrong type (malformed decode) - never coerced or fabricated", () => {
    const malformed = { ...RAW, args: { ...RAW.args, feeProtocol0New: BigInt(4) } } as unknown as Log;
    expect(decodeSetFeeProtocolLog(malformed)).toBeNull();
  });
});

describe("reconstructV3FeeProtocolSegments", () => {
  it("returns one segment spanning the whole range, from the reference state, when no transitions are found (the common case)", () => {
    const segments = reconstructV3FeeProtocolSegments(BigInt(100), BigInt(200), [], v3FeeState({ feeProtocol: 0, active: false }));
    expect(segments).toEqual([{ fromBlock: BigInt(100), toBlock: BigInt(200), feeProtocol: 0, active: false }]);
  });

  it("splits a single mid-range transition into exactly two segments with correct inclusive boundaries", () => {
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(200),
      [transition({ blockNumber: BigInt(150), feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 })],
      v3FeeState({ feeProtocol: 68, active: true }),
    );
    expect(segments).toEqual([
      { fromBlock: BigInt(100), toBlock: BigInt(149), feeProtocol: 0, active: false },
      { fromBlock: BigInt(150), toBlock: BigInt(200), feeProtocol: 68, active: true },
    ] satisfies V3FeeProtocolSegment[]);
  });

  it("REGRESSION: reconstructs inactive -> active -> inactive correctly - the exact scenario the old boundary-only check silently mis-reported as verified-zero", () => {
    // Old (buggy) logic: read feeProtocol only at block 100 (inactive) and
    // block 200 (inactive) - both agree, so the whole [100,200] range was
    // wrongly reported as verified-zero, even though [150,179] genuinely
    // had the mechanism active.
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(200),
      [
        transition({ blockNumber: BigInt(150), logIndex: 2, feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 }),
        transition({ blockNumber: BigInt(180), logIndex: 1, feeProtocol0Old: 4, feeProtocol1Old: 4, feeProtocol0New: 0, feeProtocol1New: 0 }),
      ],
      v3FeeState({ feeProtocol: 0, active: false }),
    );
    expect(segments).toEqual([
      { fromBlock: BigInt(100), toBlock: BigInt(149), feeProtocol: 0, active: false },
      { fromBlock: BigInt(150), toBlock: BigInt(179), feeProtocol: 68, active: true },
      { fromBlock: BigInt(180), toBlock: BigInt(200), feeProtocol: 0, active: false },
    ] satisfies V3FeeProtocolSegment[]);
    // The middle segment being active is exactly what must make the
    // aggregate outcome "unavailable," not "verified-zero" - see the
    // matching regression test in the resolveV3ProtocolRevenueFromSegments
    // describe block below.
    expect(segments.some((s) => s.active)).toBe(true);
  });

  it("treats a transition landing exactly at fromBlock as already reflecting the New state for the whole first segment", () => {
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(200),
      [transition({ blockNumber: BigInt(100), feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 })],
      v3FeeState({ feeProtocol: 68, active: true }),
    );
    expect(segments).toEqual([{ fromBlock: BigInt(100), toBlock: BigInt(200), feeProtocol: 68, active: true }]);
  });

  it("treats a transition landing exactly at toBlock as already reflecting the New state for the final (single-block) segment", () => {
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(200),
      [transition({ blockNumber: BigInt(200), feeProtocol0Old: 4, feeProtocol1Old: 4, feeProtocol0New: 0, feeProtocol1New: 0 })],
      v3FeeState({ feeProtocol: 0, active: false }),
    );
    expect(segments).toEqual([
      { fromBlock: BigInt(100), toBlock: BigInt(199), feeProtocol: 68, active: true },
      { fromBlock: BigInt(200), toBlock: BigInt(200), feeProtocol: 0, active: false },
    ] satisfies V3FeeProtocolSegment[]);
  });

  it("handles two transitions in the SAME block, ordered by logIndex - not the block number alone", () => {
    // A pathological but real-shaped case: two owner calls landed in the
    // same block. Passed in REVERSE logIndex order to prove this function
    // sorts them itself rather than trusting caller order.
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(200),
      [
        transition({ blockNumber: BigInt(150), logIndex: 5, feeProtocol0Old: 4, feeProtocol1Old: 4, feeProtocol0New: 6, feeProtocol1New: 6 }),
        transition({ blockNumber: BigInt(150), logIndex: 2, feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 }),
      ],
      v3FeeState({ feeProtocol: 6 + (6 << 4), active: true }),
    );
    // Only ONE segment boundary at block 150 (no spurious empty segment
    // between the two same-block transitions), and the state after block
    // 150 reflects the LAST (highest logIndex) transition's New value.
    expect(segments).toEqual([
      { fromBlock: BigInt(100), toBlock: BigInt(149), feeProtocol: 0, active: false },
      { fromBlock: BigInt(150), toBlock: BigInt(200), feeProtocol: 6 + (6 << 4), active: true },
    ] satisfies V3FeeProtocolSegment[]);
  });

  it("reconstructs a longer chain of transitions (state A -> B -> C) into exactly three segments", () => {
    const segments = reconstructV3FeeProtocolSegments(
      BigInt(100),
      BigInt(300),
      [
        transition({ blockNumber: BigInt(150), feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 4, feeProtocol1New: 4 }),
        transition({ blockNumber: BigInt(220), feeProtocol0Old: 4, feeProtocol1Old: 4, feeProtocol0New: 10, feeProtocol1New: 10 }),
      ],
      v3FeeState({ feeProtocol: 10 + (10 << 4), active: true }),
    );
    expect(segments.map((s) => s.feeProtocol)).toEqual([0, 68, 10 + (10 << 4)]);
    expect(segments.map((s) => [s.fromBlock, s.toBlock])).toEqual([
      [BigInt(100), BigInt(149)],
      [BigInt(150), BigInt(219)],
      [BigInt(220), BigInt(300)],
    ]);
  });
});

describe("resolveV3ProtocolRevenueFromSegments", () => {
  it("reports revenue as verifiably zero when the single (no-transition) segment is inactive", () => {
    const outcome = resolveV3ProtocolRevenueFromSegments(BigInt(100), BigInt(200), [
      { fromBlock: BigInt(100), toBlock: BigInt(200), feeProtocol: 0, active: false },
    ]);
    expect(outcome).toEqual({ available: true, revenueUsd: "0", reason: expect.stringContaining("blocks 100-200") });
  });

  it("reports revenue as unavailable when the single (no-transition) segment is active - the real, live state of this phase's one configured V3 pool (feeProtocol == 68)", () => {
    const outcome = resolveV3ProtocolRevenueFromSegments(BigInt(100), BigInt(200), [
      { fromBlock: BigInt(100), toBlock: BigInt(200), feeProtocol: 68, active: true },
    ]);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("collectProtocol");
    expect((outcome as { revenueUsd?: string }).revenueUsd).toBeUndefined();
  });

  it("REGRESSION: reports revenue as unavailable, never verified-zero, when an active segment sits in the middle of an otherwise-inactive range", () => {
    // Directly exercises the bug this fix closes: both the FIRST and LAST
    // segments are inactive (exactly what the old boundary-only check would
    // have seen and concluded "verified zero" from), but a real active
    // segment sits in between and must dominate the classification.
    const segments: V3FeeProtocolSegment[] = [
      { fromBlock: BigInt(100), toBlock: BigInt(149), feeProtocol: 0, active: false },
      { fromBlock: BigInt(150), toBlock: BigInt(179), feeProtocol: 68, active: true },
      { fromBlock: BigInt(180), toBlock: BigInt(200), feeProtocol: 0, active: false },
    ];
    const outcome = resolveV3ProtocolRevenueFromSegments(BigInt(100), BigInt(200), segments);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("changed within this indexed range");
    expect(outcome.reason).toContain("blocks 150-179");
    expect((outcome as { revenueUsd?: string }).revenueUsd).toBeUndefined();
  });

  it("reports revenue as verifiably zero across multiple segments when every single one is inactive (transitions that never actually activated it)", () => {
    const segments: V3FeeProtocolSegment[] = [
      { fromBlock: BigInt(100), toBlock: BigInt(149), feeProtocol: 0, active: false },
      { fromBlock: BigInt(150), toBlock: BigInt(200), feeProtocol: 0, active: false },
    ];
    const outcome = resolveV3ProtocolRevenueFromSegments(BigInt(100), BigInt(200), segments);
    expect(outcome).toEqual({ available: true, revenueUsd: "0", reason: expect.stringContaining("2 segments") });
  });

  it("never confuses an active-but-unmeasured mechanism with a genuinely zero one", () => {
    const inactive: V3FeeProtocolSegment[] = [{ fromBlock: BigInt(1), toBlock: BigInt(2), feeProtocol: 0, active: false }];
    const active: V3FeeProtocolSegment[] = [{ fromBlock: BigInt(1), toBlock: BigInt(2), feeProtocol: 68, active: true }];

    expect(resolveV3ProtocolRevenueFromSegments(BigInt(1), BigInt(2), inactive).available).toBe(true);
    expect(resolveV3ProtocolRevenueFromSegments(BigInt(1), BigInt(2), active).available).toBe(false);
  });
});
