// A deliberately dependency-free leaf module: everything here is a plain
// constant or pure function with zero imports, so nothing that imports from
// here can ever end up in an import cycle through it. Previously
// VALID_BLOCK_HASH lived in verify-pool.ts and record-verification.ts
// imported it from there - harmless on its own, but record-verification.ts
// is also imported BY verify-pool.ts (for the shared recordVerification
// write path), which made that a real circular import
// (verify-pool.ts -> record-verification.ts -> verify-pool.ts). Moving the
// shared pieces here, with nothing importing back into either
// verify-pool.ts or verify-vault.ts, breaks that cycle rather than papering
// over it.

// A real EVM block hash is always exactly 32 bytes (64 hex characters)
// after the 0x prefix - a shorter/malformed/empty string is never a real
// hash, whatever produced it. recordVerification (record-verification.ts)
// treats anything that fails this the same as a genuinely missing hash:
// never persisted as pool/vault TVL provenance.
export const VALID_BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

// onchain_verifications.key (schema.ts) is a varchar(64) column - one
// shared namespace across every category that writes to it (pools, vaults,
// and the legacy VERIFIED_PROTOCOL_TVLS entries). Both the database column
// definition itself and lib/onchain/config.ts's assertUniqueVerificationKeys
// (which validates every category's *effective* persisted key against this
// same limit before any of them ever reaches the database) depend on this
// exact number - keep the two in sync if the column is ever widened.
export const ONCHAIN_VERIFICATION_KEY_MAX_LENGTH = 64;

// The exact namespace prefix a vault's raw VERIFIED_VAULTS `key` gets
// before it's ever written to onchain_verifications.key - see
// vaultVerificationKey below for the single transformation function that
// applies it. Pool and legacy protocol-TVL keys are written bare/
// unprefixed (see verify-pool.ts / verify-protocol-tvl.ts), preserving
// exactly what Phase 4/5.1 already wrote to production - only vaults
// (introduced after onchain_verifications.key was already a single shared
// namespace) are namespaced, specifically so a vault's config key can never
// accidentally collide with an unrelated pool/protocol-TVL entry's.
export const VAULT_VERIFICATION_KEY_PREFIX = "vault:";

// The one, single-source-of-truth transformation from a VERIFIED_VAULTS
// entry's raw `key` to what actually gets persisted into
// onchain_verifications.key. Every place that needs a vault's effective
// key - the write path (verify-vault.ts's recordVaultVerification), the
// read path (lib/database/queries/vaults.ts's getVerifiedVaults join), and
// config-time validation (lib/onchain/config.ts's
// assertUniqueVerificationKeys) - calls this exact function rather than
// re-deriving the prefix locally, so the three can never silently drift
// apart from each other.
export function vaultVerificationKey(rawVaultKey: string): string {
  return `${VAULT_VERIFICATION_KEY_PREFIX}${rawVaultKey}`;
}
