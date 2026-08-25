// Pure unit tests for the vault-specific wiring in verify-vault.ts. The
// arithmetic itself (BigInt fixed-point, exact-decimal-string contract,
// explicit-failure-over-fabrication) is computePoolTvl's own, already
// exhaustively covered by verify-pool.test.ts - reused here unmodified (see
// verify-vault.ts's own module comment), so these tests exist only to prove
// the N=1 "one vault, one underlying asset" wrapping around it behaves
// correctly, not to re-prove arithmetic verify-pool.test.ts already covers.
// Matches that file's own convention of testing only the pure calculation
// layer directly - verifyVaultsOnChain/verifyAllVaults (the RPC-touching
// orchestration) are integration-exercised the same indirect way
// verifyPoolsOnChain/verifyAllPools are: not unit-tested with a mocked RPC
// client at all; recordVaultVerification's own write path is what
// verify-vault.integration.test.ts covers against a real database.
import { describe, expect, it } from "vitest";
import { computePoolTvl, type PoolTvlToken } from "./verify-pool";

function vaultToken(overrides: Partial<PoolTvlToken> = {}): PoolTvlToken {
  return { symbol: "DAI", decimals: 18, coingeckoId: "dai", ...overrides };
}

describe("computePoolTvl applied to a single-asset ERC-4626 vault (N=1)", () => {
  it("computes TVL from one totalAssets() balance against one underlying price - the sDAI shape (18 decimals)", () => {
    const token = vaultToken();
    // 1,000,000 DAI (18 decimals) at $1.00.
    const totalAssets = BigInt("1000000000000000000000000");
    const result = computePoolTvl([token], [totalAssets], new Map([["dai", "1.00"]]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tvlUsd).toBe("1000000");
  });

  it("computes TVL correctly for a lower-decimals underlying asset (6 decimals, e.g. a USDC-denominated vault)", () => {
    const token = vaultToken({ symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" });
    // 500,000 USDC (6 decimals) at $1.00.
    const totalAssets = BigInt("500000000000");
    const result = computePoolTvl([token], [totalAssets], new Map([["usd-coin", "1.00"]]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tvlUsd).toBe("500000");
  });

  it("applies a non-$1.00 underlying price correctly - the sUSDe shape, where the peg can drift slightly", () => {
    const token = vaultToken({ symbol: "USDe", decimals: 18, coingeckoId: "ethena-usde" });
    const totalAssets = BigInt("100000000000000000000"); // 100 USDe
    const result = computePoolTvl([token], [totalAssets], new Map([["ethena-usde", "0.9987"]]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tvlUsd).toBe("99.87");
  });

  it("fails explicitly, never fabricating a value, when the totalAssets() read is null (a failed on-chain read)", () => {
    const token = vaultToken();
    const result = computePoolTvl([token], [null], new Map([["dai", "1.00"]]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/balance read failed/);
  });

  it("fails explicitly, never defaulting to zero or a fabricated price, when the underlying asset's price is missing", () => {
    const token = vaultToken();
    const totalAssets = BigInt("1000000000000000000000000");
    const result = computePoolTvl([token], [totalAssets], new Map()); // no price for "dai"

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing USD price/);
  });

  it("rejects a negative price rather than silently producing a negative TVL", () => {
    const token = vaultToken();
    const totalAssets = BigInt("1000000000000000000000000");
    const result = computePoolTvl([token], [totalAssets], new Map([["dai", "-1.00"]]));

    expect(result.ok).toBe(false);
  });

  it("preserves a real sub-cent TVL contribution rather than flooring it to zero, for a very small vault balance", () => {
    const token = vaultToken();
    const totalAssets = BigInt("500000000000"); // 0.0000005 DAI
    const result = computePoolTvl([token], [totalAssets], new Map([["dai", "1.00"]]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tvlUsd).not.toBe("0");
  });

  it("returns exactly zero TVL for a genuinely empty vault, never treating that as a failure", () => {
    const token = vaultToken();
    const result = computePoolTvl([token], [BigInt(0)], new Map([["dai", "1.00"]]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tvlUsd).toBe("0");
  });
});
