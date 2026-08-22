// Pure unit tests for checkBlockHashStillCanonical - no live RPC call
// involved, matching the DI pattern used elsewhere in this codebase for
// testing RPC-touching logic (e.g. token-decimals.ts's MulticallDecimals).
import { describe, expect, it } from "vitest";
import { checkBlockHashStillCanonical } from "./reorg";

describe("checkBlockHashStillCanonical", () => {
  it("reports confirmed when the current hash still matches the pinned hash", async () => {
    const result = await checkBlockHashStillCanonical(BigInt(18000000), "0xabc123", async () => "0xabc123");
    expect(result).toEqual({ status: "confirmed", currentBlockHash: "0xabc123" });
  });

  it("is case-insensitive when comparing hashes (viem may normalize case differently across calls)", async () => {
    const result = await checkBlockHashStillCanonical(BigInt(18000000), "0xABC123", async () => "0xabc123");
    expect(result.status).toBe("confirmed");
  });

  it("reports reorged when the block at that height now resolves to a different hash", async () => {
    const result = await checkBlockHashStillCanonical(BigInt(18000000), "0xabc123", async () => "0xdef456");
    expect(result).toEqual({ status: "reorged", currentBlockHash: "0xdef456" });
  });

  it("reports unknown, never reorged, when the current hash can't be read at all", async () => {
    const result = await checkBlockHashStillCanonical(BigInt(18000000), "0xabc123", async () => null);
    expect(result).toEqual({ status: "unknown", currentBlockHash: null });
  });

  it("reports unknown, never reorged, when the reader throws (e.g. a transient RPC failure)", async () => {
    const result = await checkBlockHashStillCanonical(BigInt(18000000), "0xabc123", async () => {
      throw new Error("RPC timeout");
    });
    expect(result).toEqual({ status: "unknown", currentBlockHash: null });
  });
});
