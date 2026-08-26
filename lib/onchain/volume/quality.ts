import { parseUnits } from "viem";

const CALCULATION_SCALE = 30;

// Phase 5.4's data-quality layer for volume/fees/revenue - the same
// "mark suspicious, never delete" discipline the task requires. Every
// function here is pure and deterministic: a fixed set of checks, never a
// model, directly unit-testable with plain constructed inputs. Flags are
// returned as a string[] rather than thrown as errors - a flagged
// observation is still written (see engine.ts), with its flags preserved
// as part of its own provenance, so a human/future consumer can see
// exactly why something looked suspicious without the underlying data
// having been silently dropped.
export const QUALITY_FLAG = {
  NEGATIVE_VOLUME: "negative_volume",
  NEGATIVE_FEES: "negative_fees",
  NEGATIVE_REVENUE: "negative_revenue",
  FEES_EXCEED_VOLUME: "fees_exceed_volume",
  VOLUME_SPIKE: "volume_spike",
} as const;

// A pool's volume this run being more than this many times its own
// previous run's volume is flagged as a suspicious spike - worth a human
// look (a real listing/airdrop/exploit event, or a decoding bug), not
// silently accepted as routine. 10x is deliberately loose relative to
// ordinary day-to-day trading variance (which routinely swings 2-3x for a
// single pool) - the goal is catching a genuinely extreme, likely-wrong
// reading, not flagging every busy day.
export const VOLUME_SPIKE_MULTIPLIER = 10;

// Structural checks: negative volume/fees are not reachable through this
// phase's own arithmetic (every input is a non-negative raw on-chain
// uint256, summed and scaled with operations that can't produce a
// negative result), but checked anyway rather than assumed - the same
// "defensive floor, not merely a claim" discipline
// computePoolTvl/deriveV2Price's own decimals-overflow checks already
// establish for a similarly "shouldn't happen but never assumed
// impossible" case. fees > volume is a genuine impossibility for the
// standard swap-fee model this phase implements (a fee taken as a
// percentage of volume can never exceed the volume it was taken from) -
// if it's ever observed, that means the calculation itself is wrong, not
// that the data is unusual.
export function checkVolumeFeeConsistency(volumeUsd: string, feesUsd: string): string[] {
  const flags: string[] = [];
  const volumeAtScale = parseUnits(volumeUsd, CALCULATION_SCALE);
  const feesAtScale = parseUnits(feesUsd, CALCULATION_SCALE);

  if (volumeAtScale < BigInt(0)) flags.push(QUALITY_FLAG.NEGATIVE_VOLUME);
  if (feesAtScale < BigInt(0)) flags.push(QUALITY_FLAG.NEGATIVE_FEES);
  if (feesAtScale > volumeAtScale) flags.push(QUALITY_FLAG.FEES_EXCEED_VOLUME);

  return flags;
}

// Same structural floor as above, for the one metric this phase's
// protocol-fee engine can currently produce a real numeric value for (see
// protocol-fee.ts) - a verified-zero revenue reading is never negative by
// construction, but this exists as the same defensive, always-checked
// floor rather than an assumption, and as the ready extension point for
// whenever a genuinely non-zero revenue calculation is implemented.
export function checkRevenueConsistency(revenueUsd: string): string[] {
  const revenueAtScale = parseUnits(revenueUsd, CALCULATION_SCALE);
  return revenueAtScale < BigInt(0) ? [QUALITY_FLAG.NEGATIVE_REVENUE] : [];
}

// Compares this run's volume against the immediately preceding run's for
// the SAME pool - `previousVolumeUsd` is null on a pool's first-ever
// observation (nothing to compare against yet, never flagged) and skipped
// when the previous run itself was zero (a ratio against a zero baseline
// is not a meaningful multiple - going from $0 to any positive volume is
// not "infinitely suspicious," it's just resumed activity).
export function checkVolumeSpike(currentVolumeUsd: string, previousVolumeUsd: string | null): string[] {
  if (previousVolumeUsd == null) return [];
  const previousAtScale = parseUnits(previousVolumeUsd, CALCULATION_SCALE);
  if (previousAtScale <= BigInt(0)) return [];

  const currentAtScale = parseUnits(currentVolumeUsd, CALCULATION_SCALE);
  return currentAtScale > previousAtScale * BigInt(VOLUME_SPIKE_MULTIPLIER) ? [QUALITY_FLAG.VOLUME_SPIKE] : [];
}
