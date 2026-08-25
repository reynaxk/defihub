import { db } from "@/lib/database/client";
import { chains, protocols, vaults } from "@/lib/database/schema";
import { logger } from "@/lib/observability/logger";
import { VERIFIED_VAULTS, type VerifiedVault } from "./config";

// Keeps the `vaults` table in sync with VERIFIED_VAULTS - the exact
// structural twin of lib/onchain/pools.ts's syncPoolsFromConfig, applied to
// the new vault entity type instead of pools. Same reasoning throughout:
// the config stays the source of truth an engineer edits and reviews; this
// makes those entries queryable as real rows too, upserted by configKey;
// never auto-discovers a vault the config doesn't already list.
//
// `vaultsToSync` defaults to the real config and is only ever overridden by
// tests, same as poolsToSync.
export async function syncVaultsFromConfig(vaultsToSync: VerifiedVault[] = VERIFIED_VAULTS): Promise<Map<string, string>> {
  const vaultIdByConfigKey = new Map<string, string>();
  if (vaultsToSync.length === 0) return vaultIdByConfigKey;

  const [chainRows, protocolRows] = await Promise.all([
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
  ]);
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));

  for (const vault of vaultsToSync) {
    const chainId = chainIdBySlug.get(vault.chainSlug);
    if (!chainId) {
      // Not thrown - a chain genuinely not seeded yet is an expected,
      // recoverable state (the next sync run picks the vault up once the
      // chain exists), matching syncPoolsFromConfig's own silent-skip
      // behavior. But a silent skip with no signal at all made this hard to
      // diagnose from the outside - logged so a config entry that's
      // permanently skipped (e.g. a typo'd chainSlug that will never
      // resolve) is actually observable instead of just quietly absent from
      // `vaults` forever.
      logger.warn("skipping vault sync - chain not tracked yet", {
        component: "onchain",
        vaultKey: vault.key,
        chainSlug: vault.chainSlug,
        label: vault.label,
        vaultAddress: vault.vaultAddress,
      });
      continue;
    }
    const protocolId = protocolIdBySlug.get(vault.protocolDefillamaSlug) ?? null;

    const [row] = await db
      .insert(vaults)
      .values({
        configKey: vault.key,
        chainId,
        protocolId,
        label: vault.label,
        address: vault.vaultAddress,
        underlyingAddress: vault.underlyingAsset.address,
        underlyingSymbol: vault.underlyingAsset.symbol,
        underlyingDecimals: vault.underlyingAsset.decimals,
        underlyingCoingeckoId: vault.underlyingAsset.coingeckoId,
      })
      .onConflictDoUpdate({
        target: vaults.configKey,
        set: {
          chainId,
          protocolId,
          label: vault.label,
          address: vault.vaultAddress,
          underlyingAddress: vault.underlyingAsset.address,
          underlyingSymbol: vault.underlyingAsset.symbol,
          underlyingDecimals: vault.underlyingAsset.decimals,
          underlyingCoingeckoId: vault.underlyingAsset.coingeckoId,
          updatedAt: new Date(),
        },
      })
      .returning({ id: vaults.id });

    vaultIdByConfigKey.set(vault.key, row.id);
  }

  return vaultIdByConfigKey;
}
