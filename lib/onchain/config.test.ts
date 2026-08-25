// Pure unit tests for assertUniqueVerificationKeys - the combined
// effective-key-set validation that runs at module-load time (see
// config.ts's own top-level call). Every test here calls it with a
// synthetic `categories` override (the same test-only-override shape as
// syncPoolsFromConfig's poolsToSync) rather than mutating the real
// VERIFIED_POOLS/VERIFIED_PROTOCOL_TVLS/VERIFIED_VAULTS arrays, so this
// exercises the detection logic itself in isolation from whatever the real
// config currently contains.
//
// Vault-category tests below pass `toEffectiveKey: vaultVerificationKey` -
// the literal same function imported from lib/onchain/verification-key.ts
// that recordVaultVerification (verify-vault.ts) and getVerifiedVaults'
// join (lib/database/queries/vaults.ts) already use to compute what a
// vault's raw key actually becomes once persisted - not a hand-reimplemented
// `"vault:" + key` in the test itself, which could silently drift from the
// real transformation without anyone noticing.
import { describe, expect, it } from "vitest";
import {
  assertUniqueVerificationKeys,
  VERIFIED_POOLS,
  VERIFIED_PROTOCOL_TVLS,
  VERIFIED_VAULTS,
  type VerificationKeyCategory,
} from "./config";
import { ONCHAIN_VERIFICATION_KEY_MAX_LENGTH, vaultVerificationKey } from "./verification-key";

describe("assertUniqueVerificationKeys", () => {
  it("1. succeeds for normal, distinct pool + vault + protocol keys", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_POOLS", rawKeys: ["pool-a", "pool-b"] },
      { category: "VERIFIED_PROTOCOL_TVLS", rawKeys: ["protocol-a"] },
      { category: "VERIFIED_VAULTS", rawKeys: ["vault-a"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).not.toThrow();
  });

  it("2. fails when a vault's raw key becomes a collision only AFTER the vault: prefix is applied", () => {
    // Raw keys are genuinely different strings ("vault:shared-raw" vs
    // "shared-raw") - a raw-key-only comparison would see no collision at
    // all. Only once the vault's raw key is transformed into its effective
    // form ("vault:shared-raw") does it match the pool's own (unprefixed,
    // literal) key.
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_POOLS", rawKeys: ["vault:shared-raw"] },
      { category: "VERIFIED_VAULTS", rawKeys: ["shared-raw"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(/Duplicate effective verification key/);
  });

  it("3. fails when a vault's effective key (after the vault: prefix) exceeds 64 characters, even though the raw key alone does not", () => {
    const rawKey = "a".repeat(60); // 60 chars alone - safely under 64
    expect(rawKey.length).toBeLessThanOrEqual(ONCHAIN_VERIFICATION_KEY_MAX_LENGTH);
    expect(vaultVerificationKey(rawKey).length).toBeGreaterThan(ONCHAIN_VERIFICATION_KEY_MAX_LENGTH); // "vault:" + 60 = 66

    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_VAULTS", rawKeys: [rawKey], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(/exceeding onchain_verifications\.key/);
  });

  it("4. fails on a vault-vs-pool effective-key collision", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_POOLS", rawKeys: ["vault:collide-with-pool"] },
      { category: "VERIFIED_VAULTS", rawKeys: ["collide-with-pool"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(
      /Duplicate effective verification key "vault:collide-with-pool"/,
    );
  });

  it("5. fails on a vault-vs-legacy-protocol-TVL effective-key collision", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_PROTOCOL_TVLS", rawKeys: ["vault:collide-with-protocol"] },
      { category: "VERIFIED_VAULTS", rawKeys: ["collide-with-protocol"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(
      /Duplicate effective verification key "vault:collide-with-protocol"/,
    );
  });

  it("6. fails when two vault entries' raw keys collide with each other after the identical effective-key transformation", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_VAULTS", rawKeys: ["same-vault-key", "same-vault-key"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(
      /Duplicate effective verification key "vault:same-vault-key"/,
    );
  });

  it("still fails on a plain pool-vs-protocol collision (identical effective forms with no transformation involved at all)", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_POOLS", rawKeys: ["shared-key"] },
      { category: "VERIFIED_PROTOCOL_TVLS", rawKeys: ["shared-key"] },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(/Duplicate effective verification key "shared-key"/);
  });

  it("identifies both categories involved in a vault-vs-pool collision in the thrown message", () => {
    const categories: VerificationKeyCategory[] = [
      { category: "VERIFIED_POOLS", rawKeys: ["vault:shared-key"] },
      { category: "VERIFIED_VAULTS", rawKeys: ["shared-key"], toEffectiveKey: vaultVerificationKey },
    ];
    expect(() => assertUniqueVerificationKeys(categories)).toThrow(/VERIFIED_POOLS.*VERIFIED_VAULTS/);
  });

  it("does not throw for the real, current VERIFIED_POOLS/VERIFIED_PROTOCOL_TVLS/VERIFIED_VAULTS config, using the exact same effective-key transformation the production code path uses - this module already asserted this once at import time, but re-asserting it directly documents the invariant as an explicit, readable test rather than only an incidental side effect of importing the module", () => {
    expect(() =>
      assertUniqueVerificationKeys([
        { category: "VERIFIED_POOLS", rawKeys: VERIFIED_POOLS.map((p) => p.key) },
        { category: "VERIFIED_PROTOCOL_TVLS", rawKeys: VERIFIED_PROTOCOL_TVLS.map((e) => e.key) },
        { category: "VERIFIED_VAULTS", rawKeys: VERIFIED_VAULTS.map((v) => v.key), toEffectiveKey: vaultVerificationKey },
      ]),
    ).not.toThrow();
  });
});
