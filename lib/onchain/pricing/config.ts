import type { PriceSourceKind } from "./types";
import type { ReferenceAssetNode } from "./reference-graph";

// Phase 5.3's hand-curated reference-asset price graph. Deliberately a
// fixed, short, human-reviewed list - the same "not auto-discovered"
// discipline as VERIFIED_POOLS/VERIFIED_VAULTS (lib/onchain/config.ts) - so
// every entry's pool address and dependency has actually been looked at by
// a person, not inferred from a token list. Ethereum-only for this phase:
// see this phase's own final report for why (one chain, done correctly,
// rather than many chains done shallowly) - adding another chain is
// mechanical config addition once its own pools are independently verified,
// following the exact pattern VERIFIED_VAULTS already established for
// onboarding a new entry of an existing adapter kind.
//
// On-chain data alone cannot bootstrap an absolute USD value from reserve
// ratios - a ratio only ever gives "N units of token A per unit of token B,"
// never "token B is worth $X" without some external anchor. Every reference
// price graph needs exactly one such anchor; USDC is it here. This is a
// definitional assumption, stated plainly, not a claim that USDC's peg was
// independently verified on-chain - see ReferenceAsset's own `kind: "anchor"`
// comment. Every OTHER reference asset below (USDT, DAI, WETH, WBTC) has a
// genuinely on-chain-derived price: read from a real, verified pool against
// an already-resolved reference, with the pool's own current reserve ratio
// (not an assumed 1:1 peg) determining the result - see docs/native-data.md
// for the full "what's actually independent vs. still definitional" account.
export interface ReferenceAssetSourcePool {
  poolAddress: string;
  dexKind: PriceSourceKind;
  // The key of another ReferenceAsset in REFERENCE_ASSETS below that this
  // pool pairs the priced asset against - must already be resolved before
  // this source can be read (see reference-graph.ts's resolveReferenceOrder,
  // which this key feeds via toReferenceAssetNode below). Which side of the
  // pool (token0/token1) is which is never hardcoded here - the engine reads
  // token0()/token1() live and matches them against this asset's and the
  // paired asset's own configured addresses, failing explicitly on a
  // mismatch (see engine.ts), the same "config is the expected value, chain
  // validates it" discipline verify-vault.ts's asset() check already
  // established.
  pairedWithKey: string;
}

export interface ReferenceAsset {
  key: string;
  chainSlug: string;
  address: string;
  symbol: string;
  decimals: number;
  // Used only to label this asset when a CoinGecko price is ALSO available
  // for cross-referencing/display purposes elsewhere in the app (e.g.
  // stablecoins.ts's existing KNOWN_STABLECOIN_IDS) - never itself the
  // source of this engine's own on-chain-derived price.
  coingeckoId: string;
  kind: "anchor" | "derived";
  // Only set for kind "anchor" - the hand-declared, definitional USD price
  // (see this module's own header comment for why an anchor is unavoidable).
  // Never used for a "derived" asset, whose price always comes from
  // deriveV2Price (uniswap-v2.ts) against an already-resolved reference.
  anchorPriceUsd?: string;
  // Only set for kind "derived" - one or more real pools this asset's price
  // is read from. More than one entry here means multiple independent
  // on-chain sources feed into aggregatePrices (aggregate.ts) for this one
  // asset, not a blind average of them.
  sourcePools?: ReferenceAssetSourcePool[];
}

export const REFERENCE_ASSETS: ReferenceAsset[] = [
  {
    key: "usdc-ethereum",
    chainSlug: "ethereum",
    // Confirmed against Etherscan and this app's own already-verified
    // VERIFIED_POOLS entries (lib/onchain/config.ts), which use this exact
    // address for the same reason.
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    decimals: 6,
    coingeckoId: "usd-coin",
    kind: "anchor",
    anchorPriceUsd: "1.00",
  },
  {
    key: "weth-ethereum",
    chainSlug: "ethereum",
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    decimals: 18,
    coingeckoId: "weth",
    kind: "derived",
    sourcePools: [
      {
        // Uniswap V2 USDC/WETH - the EXACT same pool address already
        // verified and live in VERIFIED_POOLS as "uniswap-v2-eth-usdc-weth"
        // (lib/onchain/config.ts), reused here rather than re-verified from
        // scratch. Independently re-confirmed live on-chain for this phase:
        // factory.getPair(USDC, WETH) on the real Uniswap V2 Factory
        // (0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f) returns this exact
        // address; token0()/token1() on it return USDC/WETH in that order,
        // matching this entry and weth-ethereum's own pairing below.
        poolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
        dexKind: "uniswap-v2",
        pairedWithKey: "usdc-ethereum",
      },
    ],
  },
  {
    key: "usdt-ethereum",
    chainSlug: "ethereum",
    address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    symbol: "USDT",
    decimals: 6,
    coingeckoId: "tether",
    kind: "derived",
    sourcePools: [
      {
        // Uniswap V2 USDC/USDT. Verified live on-chain, same
        // factory.getPair() method as above; token0()/token1() return
        // USDC/USDT in that order. At verification time the pool's own
        // reserves (~1.6657M USDC vs ~1.6681M USDT) implied USDT trading at
        // a small discount to USDC - a real observed deviation, not
        // silently treated as an exact $1.00 peg (see this module's own
        // header comment).
        poolAddress: "0x3041cbd36888becc7bbcbc0045e3b1f144466f5f",
        dexKind: "uniswap-v2",
        pairedWithKey: "usdc-ethereum",
      },
    ],
  },
  {
    key: "dai-ethereum",
    chainSlug: "ethereum",
    address: "0x6b175474e89094c44da98b954eedeac495271d0f",
    symbol: "DAI",
    decimals: 18,
    coingeckoId: "dai",
    kind: "derived",
    sourcePools: [
      {
        // Uniswap V2 DAI/USDC. Verified live on-chain:
        // factory.getPair(DAI, USDC); token0()/token1() return DAI/USDC in
        // that order. Reserves at verification time (~544,776 DAI vs
        // ~544,068 USDC) implied DAI trading slightly above USDC - again a
        // real observed deviation, not an assumption.
        poolAddress: "0xae461ca67b15dc8dc81ce7615e0320da1a9ab8d5",
        dexKind: "uniswap-v2",
        pairedWithKey: "usdc-ethereum",
      },
    ],
  },
  {
    key: "wbtc-ethereum",
    chainSlug: "ethereum",
    address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    symbol: "WBTC",
    decimals: 8,
    coingeckoId: "wrapped-bitcoin",
    kind: "derived",
    // Depends on weth-ethereum, which itself depends on usdc-ethereum - a
    // genuine two-level chain (anchor -> WETH -> WBTC), exactly what
    // reference-graph.ts's dependency resolution exists to order correctly
    // and reject if it were ever accidentally made circular.
    sourcePools: [
      {
        // Uniswap V2 WBTC/WETH. Verified live on-chain:
        // factory.getPair(WBTC, WETH); token0()/token1() return WBTC/WETH
        // in that order. Reserves at verification time (~54.66 WBTC vs
        // ~1758.76 WETH) implied ~32.17 WETH per WBTC.
        poolAddress: "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
        dexKind: "uniswap-v2",
        pairedWithKey: "weth-ethereum",
      },
    ],
  },
  // Phase 5.7: BNB Chain reference assets. Not a new chain - "bnb-chain" is
  // already a fully supported chain (VIEM_CHAIN_BY_SLUG, confirmations.ts,
  // rpc-client.ts default URLs all already have entries, and
  // VERIFIED_POOLS/VERIFIED_TOKENS already track a real PancakeSwap pool on
  // it from an earlier phase) - this is extending an already-supported
  // chain's pricing coverage, the exact reuse this phase's own instructions
  // call for, not new-chain scope creep. Added specifically because Phase
  // 5.7's PancakeSwap volume/fee adapter (lib/onchain/volume/config.ts)
  // needs a native USD price for USDT/WBNB to produce anything above LOW
  // confidence - without these two entries, every PancakeSwap swap would be
  // permanently unpriced (getNativeTokenPrice would never resolve for BSC),
  // which would make that adapter technically "NATIVE" but practically
  // useless. Same anchor+derived shape as usdc-ethereum/weth-ethereum above,
  // not a new pattern.
  {
    key: "usdt-bnb-chain",
    chainSlug: "bnb-chain",
    // BSC-USD (Binance-Peg BSC-USD), the token this chain's ecosystem
    // universally calls "USDT" - confirmed live via token0() against the
    // same pool used below, and already tracked as this exact address/
    // decimals pair in VERIFIED_POOLS's pancakeswap-amm-bsc-usdt-wbnb entry
    // (lib/onchain/config.ts). 18 decimals, NOT 6 like Ethereum's USDT - the
    // same decimals gotcha that entry's own comment already documents.
    address: "0x55d398326f99059ff775485246999027b3197955",
    symbol: "USDT",
    decimals: 18,
    coingeckoId: "tether",
    kind: "anchor",
    // Same definitional-anchor role as usdc-ethereum above - one stablecoin
    // per chain has to be the hand-declared $1.00 starting point (see this
    // module's own header comment), not independently corroborated on-chain.
    anchorPriceUsd: "1.00",
  },
  {
    key: "wbnb-bnb-chain",
    chainSlug: "bnb-chain",
    address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    symbol: "WBNB",
    decimals: 18,
    coingeckoId: "wbnb",
    kind: "derived",
    sourcePools: [
      {
        // PancakeSwap V2 USDT/WBNB - the EXACT same pool address already
        // verified and live in VERIFIED_POOLS as
        // "pancakeswap-amm-bsc-usdt-wbnb" (lib/onchain/config.ts) and in
        // VOLUME_SOURCE_POOLS for volume/fees (lib/onchain/volume/config.ts) -
        // reused here for pricing rather than re-verified from scratch, the
        // same "one verified pool, multiple purposes" precedent
        // weth-ethereum's own comment establishes for the Ethereum
        // USDC/WETH pool. Independently re-confirmed live for this phase:
        // getReserves()/token0()/token1() on the real PancakeSwap V2 Factory
        // deployment (0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73) - token0()
        // returns USDT, token1() returns WBNB, matching this entry and
        // usdt-bnb-chain's pairing below exactly. Reserves at verification
        // time (~40.71M USDT vs ~58,243.79 WBNB) implied WBNB trading at
        // ~$698.90 - a plausible real value, not assumed.
        poolAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
        dexKind: "uniswap-v2",
        pairedWithKey: "usdt-bnb-chain",
      },
    ],
  },
];

// The exact dependency shape reference-graph.ts's resolveReferenceOrder
// needs - derived once here (not hand-duplicated) from each asset's own
// sourcePools, so the dependency graph can never silently drift from the
// pools actually configured to produce it.
export function toReferenceAssetNode(asset: ReferenceAsset): ReferenceAssetNode {
  const dependsOn = asset.kind === "anchor" ? [] : [...new Set((asset.sourcePools ?? []).map((p) => p.pairedWithKey))];
  return { key: asset.key, dependsOn };
}
