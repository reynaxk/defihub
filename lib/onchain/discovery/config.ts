// Phase 5.9's hand-curated FACTORY deployment list - the "deployment
// configuration" half of Section 12's own configuration-vs-discovery
// boundary. What genuinely belongs here: WHICH factory contract, on WHICH
// chain, for WHICH protocol, and that deployment's own immutable fee model
// - facts about the deployment itself, verified once by a person, that
// don't change per-pool. What does NOT belong here: pool addresses, token
// addresses, token metadata, creation blocks - anything the chain itself
// can tell us once a genuine factory relationship is confirmed. That's
// discovered state (lib/onchain/discovery/scan.ts/validate.ts), never
// hand-typed into this file.
//
// Both entries below reuse factory addresses ALREADY independently
// verified elsewhere in this app, not researched fresh for this phase:
// - Uniswap V2 Factory (Ethereum): the exact same address already used in
//   lib/onchain/volume/config.ts's "uniswap-v2-eth-usdc-weth" entry and
//   lib/onchain/pricing/config.ts's own factory.getPair() verification
//   comments.
// - PancakeSwap V2 Factory (BNB Chain): the exact same address already
//   used in lib/onchain/volume/config.ts's
//   "pancakeswap-amm-bsc-usdt-wbnb" entry, confirmed live via that pool's
//   own factory() call during Phase 5.7's development.
//
// Only V2-style (PairCreated-emitting) factories are in scope for
// discovery this phase - see this module's own dexKind field. Uniswap V3's
// discovery shape is genuinely different (PoolCreated, a fee-tier
// parameter as part of the pool's own identity, no single fixed per-
// deployment fee) and is deliberately NOT forced into this same config
// shape or discovery pipeline - see docs/native-data.md's Phase 5.9
// section for why V3 discovery is out of scope this round, not merely
// unimplemented by oversight.
interface FactoryDeploymentBase {
  key: string;
  chainSlug: string;
  protocolDefillamaSlug: string;
  factoryAddress: string;
  // A FLOOR for where discovery scanning starts if no cursor exists yet -
  // deliberately a recent block, not this factory's deployment block (a
  // full historical backfill of every pair ever created is explicitly out
  // of scope - this phase proves the pipeline works, not that it has
  // scanned years of history). Same "effectiveStartBlock only actually
  // uses this if it's still within the provider's live-servable window"
  // caveat as VolumeSourcePool.startBlock - see engine.ts.
  startBlock: bigint;
}

export interface UniswapV2FactoryDeployment extends FactoryDeploymentBase {
  dexKind: "uniswap-v2";
  // This deployment's own fixed, contract-hardcoded swap fee, in the
  // shared bps-out-of-10,000 unit lib/onchain/volume/math.ts's
  // computeSwapFeeUsd expects - the SAME "config-verified-once, immutable
  // for every pool this factory ever deploys" precedent
  // VolumeSourcePool.feeBps already established for Uniswap V2/PancakeSwap
  // V2 (lib/onchain/volume/config.ts). Trusting this value for a
  // DISCOVERED pool reduces to confirming that pool was genuinely deployed
  // by this exact factory (validate.ts's own factory() check) - the same
  // reduction the hand-curated config entries already rely on, just
  // applied automatically instead of hand-verified per pool.
  feeBps: number;
}

// Phase 5.11: V3 deployments deliberately have NO feeBps field here - a V3
// factory can deploy the SAME token pair at multiple independent fee
// tiers, each its own distinct pool, so unlike V2 the fee is a fact about
// the DISCOVERED pool itself (the PoolCreated event's own indexed `fee`
// parameter, persisted on discoveredPools.feeTier and cross-checked
// against the pool's own live fee() call in validate.ts), never a
// deployment-level config constant. See scan.ts's own
// POOL_CREATED_EVENT_SIGNATURE comment for the live verification this
// entry's factory address and event shape are both based on.
export interface UniswapV3FactoryDeployment extends FactoryDeploymentBase {
  dexKind: "uniswap-v3";
}

export type FactoryDeployment = UniswapV2FactoryDeployment | UniswapV3FactoryDeployment;

export const FACTORY_DEPLOYMENTS: readonly FactoryDeployment[] = [
  {
    key: "uniswap-v2-ethereum",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "uniswap-v2",
    dexKind: "uniswap-v2",
    // The real Uniswap V2 Factory - already verified live elsewhere in
    // this app (see module comment above).
    factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    // 30 bps (0.30%) - hardcoded into the canonical Uniswap V2 pair
    // contract's own constant-product accounting for every pool this
    // factory deploys (the well-known 997/1000 factor), not a
    // per-deployment-configurable parameter - see
    // lib/onchain/volume/config.ts's own "uniswap-v2-eth-usdc-weth" entry
    // for the identical reasoning already established for the
    // hand-curated pool.
    feeBps: 30,
    // ~1,900 blocks before the chain head at config-authoring time
    // (25,862,906).
    startBlock: BigInt(25861000),
  },
  {
    key: "pancakeswap-v2-bnb-chain",
    chainSlug: "bnb-chain",
    protocolDefillamaSlug: "pancakeswap-amm",
    dexKind: "uniswap-v2",
    // The real, canonical PancakeSwap V2 Factory - already verified live
    // elsewhere in this app (see module comment above).
    factoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    // 25 bps (0.25%) - PancakeSwap V2's own fixed, contract-hardcoded swap
    // fee (a 9975/10000 factor) for every pool this factory deploys - the
    // same reasoning as lib/onchain/volume/config.ts's own
    // "pancakeswap-amm-bsc-usdt-wbnb" entry.
    feeBps: 25,
    // ~2,000 blocks before the chain head at config-authoring time
    // (118,820,992).
    startBlock: BigInt(118819000),
  },
  {
    key: "uniswap-v3-ethereum",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "uniswap-v3",
    dexKind: "uniswap-v3",
    // The real, canonical Uniswap V3 Factory - the exact same address
    // already independently verified and live in VERIFIED_POOLS as
    // "uniswap-v3-eth-usdc-weth-005" (lib/onchain/config.ts), where its
    // TVL has been natively computed since Phase 4/5 and its Swap events
    // natively indexed for volume/fees since Phase 5.6 - not a fresh,
    // unverified address for this phase.
    factoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    // ~24,000 blocks before the chain head at config-authoring time
    // (25,885,143) - same "recent floor, not a historical backfill" intent
    // as the V2 entries above; effectiveStartBlock corrects this further
    // if it's gone stale by the time discovery actually runs.
    startBlock: BigInt(25861000),
  },
];
