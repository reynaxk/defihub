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
import { assetAddressMatchesConfig, buildVaultMulticallCalls, CALLS_PER_VAULT } from "./verify-vault";
import { VERIFIED_VAULTS, type VerifiedVault } from "./config";

function vaultToken(overrides: Partial<PoolTvlToken> = {}): PoolTvlToken {
  return { symbol: "DAI", decimals: 18, coingeckoId: "dai", ...overrides };
}

describe("computePoolTvl applied to a single-asset ERC-4626 vault (N=1)", () => {
  it("computes TVL from one totalAssets() balance against one underlying price - using sDAI's actual VERIFIED_VAULTS config entry, not a hand-built token", () => {
    // Exercises the exact same token shape verifyVaultsOnChain itself
    // builds (see its own `const token: PoolTvlToken = {...}` from
    // vault.underlyingAsset) - a config change to sDAI's decimals or
    // coingeckoId would break this test too, unlike a fully hand-written
    // PoolTvlToken that could silently drift out of sync with the real
    // config.
    const sdai = VERIFIED_VAULTS.find((v) => v.key === "sdai-ethereum");
    if (!sdai) throw new Error("expected VERIFIED_VAULTS to contain the sdai-ethereum entry");

    // Confirms the test is genuinely exercising sDAI's configured identity,
    // not just an entry that happens to also be named DAI/18/dai.
    expect(sdai.underlyingAsset.decimals).toBe(18);
    expect(sdai.underlyingAsset.coingeckoId).toBe("dai");

    const token: PoolTvlToken = {
      symbol: sdai.underlyingAsset.symbol,
      decimals: sdai.underlyingAsset.decimals,
      coingeckoId: sdai.underlyingAsset.coingeckoId,
    };
    // 1,000,000 DAI at sDAI's configured 18 decimals, at $1.00.
    const totalAssets = BigInt(1_000_000) * BigInt(10) ** BigInt(sdai.underlyingAsset.decimals);
    const result = computePoolTvl([token], [totalAssets], new Map([[sdai.underlyingAsset.coingeckoId, "1.00"]]));

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

describe("assetAddressMatchesConfig", () => {
  it("returns true when the on-chain asset() result matches the configured underlying asset address exactly", () => {
    expect(assetAddressMatchesConfig("0x6b175474e89094c44da98b954eedeac495271d0f", "0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(
      true,
    );
  });

  it("returns true for a case-only difference - EVM addresses are not case-sensitive identity", () => {
    // The exact DAI address, but with EIP-55 checksum capitalization -
    // still the same address as the all-lowercase config value.
    expect(assetAddressMatchesConfig("0x6B175474E89094C44Da98b954EedeAC495271d0F", "0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(
      true,
    );
  });

  it("returns false for a genuinely different address, never silently accepting a mismatch", () => {
    // sUSDe's real underlying (USDe), compared against sDAI's configured
    // underlying (DAI) - two real, distinct, correctly-formatted addresses
    // that must never be treated as a match.
    expect(assetAddressMatchesConfig("0x4c9edd5852cd905f086c759e8383e09bff1e68b3", "0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(
      false,
    );
  });
});

describe("buildVaultMulticallCalls", () => {
  const vaultA: VerifiedVault = {
    key: "test-vault-a",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "test-protocol",
    label: "Test Vault A",
    vaultAddress: "0x1111111111111111111111111111111111111a",
    underlyingAsset: { address: "0x2222222222222222222222222222222222222b", symbol: "TOKA", decimals: 18, coingeckoId: "toka" },
  };
  const vaultB: VerifiedVault = {
    ...vaultA,
    key: "test-vault-b",
    vaultAddress: "0x3333333333333333333333333333333333333c",
  };

  it("emits exactly totalAssets() immediately followed by asset(), both against the same vault address, for each vault", () => {
    const calls = buildVaultMulticallCalls([vaultA, vaultB]);

    expect(calls).toHaveLength(2 * CALLS_PER_VAULT);
    expect(calls[0]).toMatchObject({ address: vaultA.vaultAddress, functionName: "totalAssets" });
    expect(calls[1]).toMatchObject({ address: vaultA.vaultAddress, functionName: "asset" });
    expect(calls[2]).toMatchObject({ address: vaultB.vaultAddress, functionName: "totalAssets" });
    expect(calls[3]).toMatchObject({ address: vaultB.vaultAddress, functionName: "asset" });
  });

  it("produces the exact index math verifyVaultsOnChain relies on to pair each vault's two results back up (i * CALLS_PER_VAULT)", () => {
    const vaults = [vaultA, vaultB];
    const calls = buildVaultMulticallCalls(vaults);

    for (let i = 0; i < vaults.length; i++) {
      expect(calls[i * CALLS_PER_VAULT].address).toBe(vaults[i].vaultAddress);
      expect(calls[i * CALLS_PER_VAULT].functionName).toBe("totalAssets");
      expect(calls[i * CALLS_PER_VAULT + 1].address).toBe(vaults[i].vaultAddress);
      expect(calls[i * CALLS_PER_VAULT + 1].functionName).toBe("asset");
    }
  });

  it("returns an empty array for an empty vault list, never throwing", () => {
    expect(buildVaultMulticallCalls([])).toEqual([]);
  });
});
