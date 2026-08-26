// Pure unit tests for the data-quality checks - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { checkRevenueConsistency, checkVolumeFeeConsistency, checkVolumeSpike, QUALITY_FLAG } from "./quality";

describe("checkVolumeFeeConsistency", () => {
  it("flags nothing for a normal, consistent run", () => {
    expect(checkVolumeFeeConsistency("1000", "3")).toEqual([]);
  });

  it("flags fees exceeding volume as a structural impossibility", () => {
    expect(checkVolumeFeeConsistency("100", "150")).toEqual([QUALITY_FLAG.FEES_EXCEED_VOLUME]);
  });

  it("treats fees exactly equal to volume as consistent (a 100% fee is unusual, not impossible)", () => {
    expect(checkVolumeFeeConsistency("100", "100")).toEqual([]);
  });

  it("flags $0 volume/fees as fine (a genuinely empty run)", () => {
    expect(checkVolumeFeeConsistency("0", "0")).toEqual([]);
  });
});

describe("checkRevenueConsistency", () => {
  it("flags nothing for a verified-zero revenue reading", () => {
    expect(checkRevenueConsistency("0")).toEqual([]);
  });
});

describe("checkVolumeSpike", () => {
  it("never flags a pool's first-ever observation (nothing to compare against)", () => {
    expect(checkVolumeSpike("1000000", null)).toEqual([]);
  });

  it("never flags growth from a zero baseline (resumed activity, not a meaningful multiple)", () => {
    expect(checkVolumeSpike("500", "0")).toEqual([]);
  });

  it("does not flag ordinary day-to-day variance", () => {
    expect(checkVolumeSpike("2500", "1000")).toEqual([]);
  });

  it("flags a genuinely extreme jump (>10x the previous run)", () => {
    expect(checkVolumeSpike("15000", "1000")).toEqual([QUALITY_FLAG.VOLUME_SPIKE]);
  });

  it("does not flag exactly at the 10x boundary", () => {
    expect(checkVolumeSpike("10000", "1000")).toEqual([]);
  });
});
