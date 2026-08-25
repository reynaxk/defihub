// Pure unit tests for assertUniqueVerificationKeys - the combined-key-set
// validation that runs at module-load time (see config.ts's own top-level
// call). Every test here calls it with a synthetic `categories` override
// (the same test-only-override shape as syncPoolsFromConfig's poolsToSync)
// rather than mutating the real VERIFIED_POOLS/VERIFIED_PROTOCOL_TVLS/
// VERIFIED_VAULTS arrays, so this exercises the detection logic itself in
// isolation from whatever the real config currently contains.
import { describe, expect, it } from "vitest";
import { assertUniqueVerificationKeys, VERIFIED_POOLS, VERIFIED_PROTOCOL_TVLS, VERIFIED_VAULTS } from "./config";

describe("assertUniqueVerificationKeys", () => {
  it("does not throw for a combined key set with no duplicates", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_POOLS", ["pool-a", "pool-b"]],
        ["VERIFIED_PROTOCOL_TVLS", ["protocol-a"]],
        ["VERIFIED_VAULTS", ["vault-a"]],
      ]),
    ).not.toThrow();
  });

  it("throws when a pool key equals a vault key", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_POOLS", ["shared-key"]],
        ["VERIFIED_VAULTS", ["shared-key"]],
      ]),
    ).toThrow(/Duplicate verification key "shared-key"/);
  });

  it("throws when a protocol-TVL key equals a vault key", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_PROTOCOL_TVLS", ["shared-key"]],
        ["VERIFIED_VAULTS", ["shared-key"]],
      ]),
    ).toThrow(/Duplicate verification key "shared-key"/);
  });

  it("throws when a pool key equals a protocol-TVL key", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_POOLS", ["shared-key"]],
        ["VERIFIED_PROTOCOL_TVLS", ["shared-key"]],
      ]),
    ).toThrow(/Duplicate verification key "shared-key"/);
  });

  it("throws for a duplicate within a single category too, not just across categories", () => {
    expect(() => assertUniqueVerificationKeys([["VERIFIED_POOLS", ["pool-a", "pool-a"]]])).toThrow(
      /Duplicate verification key "pool-a"/,
    );
  });

  it("identifies both categories involved in the collision in the thrown message", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_POOLS", ["shared-key"]],
        ["VERIFIED_VAULTS", ["shared-key"]],
      ]),
    ).toThrow(/VERIFIED_POOLS.*VERIFIED_VAULTS/);
  });

  it("does not throw for the real, current VERIFIED_POOLS/VERIFIED_PROTOCOL_TVLS/VERIFIED_VAULTS config - this module already asserted this once at import time, but re-asserting it directly documents the invariant as an explicit, readable test rather than only an incidental side effect of importing the module", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        ["VERIFIED_POOLS", VERIFIED_POOLS.map((p) => p.key)],
        ["VERIFIED_PROTOCOL_TVLS", VERIFIED_PROTOCOL_TVLS.map((e) => e.key)],
        ["VERIFIED_VAULTS", VERIFIED_VAULTS.map((v) => v.key)],
      ]),
    ).not.toThrow();
  });
});
