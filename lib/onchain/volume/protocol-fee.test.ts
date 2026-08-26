// Pure unit tests for the protocol-revenue decision - no RPC. Covers both
// branches explicitly, including the "active" branch this phase's one real
// configured pool actually exercises live (factory.feeTo() ==
// 0xf38521f130fcCF29dB1961597bc5d2B60F995f85, verified during this phase's
// own development - see config.ts's feeVerification comment).
import { describe, expect, it } from "vitest";
import { resolveProtocolRevenue, type ProtocolFeeState } from "./protocol-fee";

describe("resolveProtocolRevenue", () => {
  it("reports revenue as verifiably zero when feeTo() is the zero address", () => {
    const state: ProtocolFeeState = {
      factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      feeToAddress: "0x0000000000000000000000000000000000000000",
      active: false,
    };
    const outcome = resolveProtocolRevenue(state);
    expect(outcome).toEqual({
      available: true,
      revenueUsd: "0",
      reason: expect.stringContaining("verifiably inactive"),
    });
  });

  it("reports revenue as unavailable (never fabricated as volume x a fraction) when feeTo() is active - the real, live state of this phase's one configured pool", () => {
    const state: ProtocolFeeState = {
      factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      feeToAddress: "0xf38521f130fcCF29dB1961597bc5d2B60F995f85",
      active: true,
    };
    const outcome = resolveProtocolRevenue(state);
    expect(outcome.available).toBe(false);
    expect(outcome.reason).toContain("Mint/Burn");
    expect((outcome as { revenueUsd?: string }).revenueUsd).toBeUndefined();
  });

  it("never confuses an active-but-unmeasured mechanism with a genuinely zero one", () => {
    const inactive = resolveProtocolRevenue({ factoryAddress: "0xf", feeToAddress: "0x0000000000000000000000000000000000000000", active: false });
    const active = resolveProtocolRevenue({ factoryAddress: "0xf", feeToAddress: "0xabc", active: true });
    expect(inactive.available).toBe(true);
    expect(active.available).toBe(false);
  });
});
