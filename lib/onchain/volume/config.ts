import type { VolumeSourceKind } from "./types";

// Phase 5.4's hand-curated volume-source pool list. Same "fixed, short,
// human-reviewed list" discipline as VERIFIED_POOLS/REFERENCE_ASSETS
// (lib/onchain/config.ts, lib/onchain/pricing/config.ts) - every entry's
// pool address, fee model, and starting block has actually been verified
// by a person against live chain state, not assumed from a protocol's
// general reputation.
//
// Exactly one entry this phase: the real, canonical Uniswap V2 USDC/WETH
// pool - the SAME pool address already verified and live in VERIFIED_POOLS
// as "uniswap-v2-eth-usdc-weth" (lib/onchain/config.ts) and already reused
// as a reference-price source in REFERENCE_ASSETS
// (lib/onchain/pricing/config.ts's "weth-ethereum" entry). Reusing the
// identical, already-thrice-verified address rather than researching a new
// one - see this phase's own final report for why coverage stayed this
// narrow: a smaller amount of genuinely verified, fully-tested coverage is
// worth more than a wider surface built on assumption.
export interface VolumeSourceToken {
  address: string;
  symbol: string;
  decimals: number;
  coingeckoId: string;
}

export interface VolumeSourcePool {
  // Matches VERIFIED_POOLS' own `key` for the same pool - deliberately the
  // identical string, so the two configs can never silently drift about
  // which real pool "uniswap-v2-eth-usdc-weth" refers to.
  key: string;
  chainSlug: string;
  poolAddress: string;
  sourceKind: VolumeSourceKind;
  // Position matches the pool's own on-chain token0()/token1() ordering -
  // engine.ts verifies this live (the same "config is the expected value,
  // chain validates it, never the reverse" discipline verify-vault.ts's
  // asset() check and pricing/engine.ts's pair-mismatch check already
  // established), never assumed from config alone.
  token0: VolumeSourceToken;
  token1: VolumeSourceToken;
  // The factory that deployed this pool - needed to read feeTo() for
  // protocol-revenue determination (lib/onchain/volume/protocol-fee.ts).
  // Kept per-entry rather than a single shared constant: a different
  // V2-style fork would have a different factory, and this config already
  // treats every deployment's identity as independently verified rather
  // than assumed.
  factoryAddress: string;
  // The swap fee this deployment charges, in basis points (30 = 0.30%).
  // NEVER a global default applied to every V2-shaped pool - see
  // this file's own header and each entry's `feeVerification` field for
  // why this specific value is trusted for this specific deployment.
  feeBps: number;
  feeVerification: string;
  // A FLOOR, not a guarantee, for where indexing starts if no cursor
  // exists yet - deliberately a recent block, not this pool's deployment
  // block (a full historical backfill is explicitly out of scope for this
  // phase, matching lib/indexing/events.ts's own foundation-only scope).
  // engine.ts's effectiveStartBlock only actually uses this value if it's
  // still within the free RPC provider's own live-servable window at
  // runtime (empirically ~100 blocks behind head - see that function's own
  // comment for how this was discovered); otherwise it starts from
  // whatever recent block the provider can actually serve instead,
  // regardless of how stale this config value has become. The live-indexed
  // history simply starts from wherever the first successful run actually
  // began, honestly, rather than claiming a completeness this phase never
  // attempted.
  startBlock: bigint;
}

export const VOLUME_SOURCE_POOLS: VolumeSourcePool[] = [
  {
    key: "uniswap-v2-eth-usdc-weth",
    chainSlug: "ethereum",
    poolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    sourceKind: "uniswap-v2",
    token0: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, coingeckoId: "usd-coin" },
    token1: { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18, coingeckoId: "weth" },
    // The real Uniswap V2 Factory - the exact same address already used in
    // lib/onchain/pricing/config.ts's own factory.getPair() verification.
    factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    // 30 bps (0.30%) - the fee is hardcoded into the canonical Uniswap V2
    // pair contract's own constant-product accounting (the well-known
    // 997/1000 factor applied to the input amount inside swap()'s
    // K-invariant check), not a per-deployment-configurable parameter for
    // a genuine factory-deployed pair. Trusting this value therefore
    // reduces to confirming this IS a genuine factory-deployed pair, which
    // feeVerification below does directly.
    feeBps: 30,
    // Verified live on-chain: this pair's own factory() call returns
    // 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f - the real Uniswap V2
    // Factory address, the exact same address already used elsewhere in
    // this app (lib/onchain/pricing/config.ts's own factory.getPair()
    // verification comments) - confirming this pair was genuinely deployed
    // by the canonical factory, not a fork that could charge a different
    // fee. Also independently confirmed factory.feeTo() at the same time:
    // it returns 0xf38521f130fcCF29dB1961597bc5d2B60F995f85 (non-zero) -
    // the protocol-fee mechanism IS active for this deployment. That does
    // NOT make protocol_revenue_usd computable here: the active mechanism
    // mints LP-share dilution to feeTo only at the next Mint/Burn event,
    // proportional to sqrt(k) growth since the last liquidity change - a
    // genuinely different, more complex read (K-growth + Mint/Burn event
    // tracking) than anything this phase implements. See
    // lib/onchain/volume/protocol-fee.ts's own module comment for the full
    // reasoning and the explicit "unavailable" outcome this produces.
    feeVerification: "pair.factory() == 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f (verified live)",
    // ~1,660 blocks before the chain head at verification time
    // (25,839,660) - comfortably within one indexing run's reach even at
    // this app's own confirmed-safe eth_getLogs chunk size (see engine.ts's
    // DEFAULT_VOLUME_CHUNK_SIZE), and the exact window this phase's own
    // Swap-event fixtures (uniswap-v2.test.ts) were pulled from live.
    startBlock: BigInt(25838000),
  },
  // Phase 5.7: PancakeSwap V2 (BNB Chain) - confirmed live to be a
  // byte-for-byte Uniswap V2 fork (identical getReserves()/token0()/
  // token1()/Swap-event shape and topic0), so this reuses the existing
  // uniswap-v2.ts decode/math adapter with zero new code, same as
  // engine.ts's sourceKind dispatch already does for it. The SAME pool
  // address already verified in VERIFIED_POOLS
  // ("pancakeswap-amm-bsc-usdt-wbnb", lib/onchain/config.ts) and now also
  // reused as this chain's WBNB reference-price source
  // (lib/onchain/pricing/config.ts's "wbnb-bnb-chain" entry) - one verified
  // pool serving TVL, pricing, and volume/fees, the same "verify once, reuse
  // everywhere" discipline the Ethereum USDC/WETH pool already established.
  {
    key: "pancakeswap-amm-bsc-usdt-wbnb",
    chainSlug: "bnb-chain",
    poolAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
    sourceKind: "uniswap-v2",
    token0: { address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18, coingeckoId: "tether" },
    token1: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB", decimals: 18, coingeckoId: "wbnb" },
    // The real, canonical PancakeSwap V2 Factory - confirmed live via this
    // pool's own factory() call.
    factoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    // 25 bps (0.25%) - PancakeSwap V2's own fixed, immutable swap fee,
    // hardcoded into its pair contract's swap() constant-product check (a
    // 9975/10000 factor, PancakeSwap's own well-known deviation from
    // Uniswap V2's 9970/10000/30bps) - NOT configurable per-pool the way
    // Aerodrome's factory-governed fee is (see docs/native-data.md's Phase
    // 5.7 section for why Aerodrome was audited and rejected this round on
    // exactly that basis). Trusting this value reduces to confirming this
    // IS a genuine PancakeSwap-V2-factory-deployed pair, which
    // feeVerification below does directly.
    feeBps: 25,
    // Verified live on-chain: this pair's own factory() call returns
    // 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 - the real, well-known
    // PancakeSwap V2 Factory address. Also independently confirmed
    // factory.feeTo() at the same time: it returns
    // 0x0ed943Ce24BaEBF257488771759F9BF482C39706 (non-zero) - the
    // protocol-fee mechanism IS active for this deployment, the same
    // "active but unavailable without Mint/Burn + K-growth tracking"
    // situation as the Ethereum V2 pool - see protocol-fee.ts's existing V2
    // revenue logic, reused unmodified via engine.ts's sourceKind dispatch.
    feeVerification: "pair.factory() == 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 (verified live)",
    // ~1,257 blocks before BNB Chain's head at verification time
    // (118,258,257), comfortably within one indexing run's reach.
    startBlock: BigInt(118257000),
  },
];
