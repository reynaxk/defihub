// The hand-picked set of on-chain reads this feature verifies. Deliberately
// a fixed, short list - not auto-discovered - since each entry needs a human
// to have confirmed the contract address, chain, and TVL math actually apply.
// See docs/architecture.md "On-chain verification" for the two categories
// this covers (AMM pools below, and single-value protocol accounting calls
// further down) and why lending/vault protocols still don't fit either one.

export interface VerifiedPoolToken {
  address: string;
  symbol: string;
  decimals: number;
  coingeckoId: string;
}

export interface VerifiedPool {
  key: string;
  chainSlug: string; // one of SUPPORTED_CHAINS' slugs (lib/config/chains.ts)
  protocolDefillamaSlug: string; // joins to `protocols.defillamaSlug` to attach the row
  label: string;
  poolAddress: string;
  // Every token this pool contract itself holds a balance of - TVL is the
  // sum of (balance * price) across all of them. Works for both classic
  // two-token constant-product pools and pools with more than two tokens,
  // as long as the contract's own balance is the source of truth (true for
  // every entry here - see the module comment above for what's excluded).
  tokens: VerifiedPoolToken[];
}

export const VERIFIED_POOLS: VerifiedPool[] = [
  {
    key: "uniswap-v3-eth-usdc-weth-005",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "uniswap-v3",
    label: "USDC/WETH 0.05% (Ethereum)",
    // Confirmed against Etherscan/GeckoTerminal, 2026-08-17.
    poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    tokens: [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        coingeckoId: "usd-coin",
      },
      {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        decimals: 18,
        coingeckoId: "weth",
      },
    ],
  },
  {
    key: "uniswap-v2-eth-usdc-weth",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "uniswap-v2",
    label: "USDC/WETH (Ethereum)",
    // Confirmed via GeckoTerminal's top-pools API and directly on-chain
    // (token0()/token1() called against the pool contract itself returned
    // these exact two addresses), 2026-08-18.
    poolAddress: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
    tokens: [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        coingeckoId: "usd-coin",
      },
      {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        decimals: 18,
        coingeckoId: "weth",
      },
    ],
  },
  {
    key: "aerodrome-v1-base-usdc-weth",
    chainSlug: "base",
    protocolDefillamaSlug: "aerodrome-v1",
    label: "USDC/WETH (Base)",
    // Confirmed via GeckoTerminal's top-pools API and directly on-chain
    // (token0()/token1() called against the pool contract itself returned
    // these exact two addresses), 2026-08-18.
    poolAddress: "0xcdac0d6c6c59727a65f871236188350531885c43",
    tokens: [
      {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        decimals: 6,
        coingeckoId: "usd-coin",
      },
      {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
        // NOT the same CoinGecko id as Ethereum's WETH ("weth") - Base's
        // WETH is a distinct bridged-asset listing. Confirmed via
        // CoinGecko's /coins/base/contract/{address} lookup rather than
        // assumed, since reusing "weth" here would have silently returned
        // no price (or the wrong one) for this token.
        coingeckoId: "l2-standard-bridged-weth-base",
      },
    ],
  },
  {
    key: "uniswap-v3-arb-usdc-weth-005",
    chainSlug: "arbitrum",
    protocolDefillamaSlug: "uniswap-v3",
    label: "USDC/WETH 0.05% (Arbitrum)",
    // Confirmed via GeckoTerminal's top-pools API and directly on-chain
    // (token0()/token1() called against the pool contract itself returned
    // these exact two addresses), 2026-08-18.
    poolAddress: "0xc6962004f452be9203591991d15f6b388e09e8d0",
    tokens: [
      {
        address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        symbol: "USDC",
        decimals: 6,
        coingeckoId: "usd-coin",
      },
      {
        address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        symbol: "WETH",
        decimals: 18,
        // A third distinct per-chain WETH id (same pattern as Base above) -
        // confirmed via CoinGecko's /coins/arbitrum-one/contract/{address}
        // lookup rather than reused from Ethereum's or Base's entry.
        coingeckoId: "arbitrum-bridged-weth-arbitrum-one",
      },
    ],
  },
  {
    key: "uniswap-v3-op-usdc-weth-03",
    chainSlug: "optimism",
    protocolDefillamaSlug: "uniswap-v3",
    label: "USDC/WETH 0.3% (Optimism)",
    // Confirmed via GeckoTerminal's top-pools API and directly on-chain
    // (token0()/token1() called against the pool contract itself returned
    // these exact two addresses), 2026-08-18.
    poolAddress: "0xc1738d90e2e26c35784a0d3e3d8a9f795074bca4",
    tokens: [
      {
        address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
        symbol: "USDC",
        decimals: 6,
        // CoinGecko's /coins/optimistic-ethereum/contract/{address} lookup
        // for this exact address returned id "usdc" - which turned out to
        // be a red herring: that id doesn't resolve on /simple/price at
        // all (a different, non-pricing-active listing that happens to
        // share the slug). Cross-checked the other direction instead -
        // fetched /coins/usd-coin directly and confirmed its own
        // "platforms.optimistic-ethereum" field lists this exact address.
        // "usd-coin" is the id that actually prices; used that.
        coingeckoId: "usd-coin",
      },
      {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
        // Another distinct per-chain WETH id, same pattern as Base/Arbitrum
        // above - confirmed via the contract lookup, not assumed.
        coingeckoId: "l2-standard-bridged-weth-optimism",
      },
    ],
  },
  {
    key: "pancakeswap-amm-bsc-usdt-wbnb",
    chainSlug: "bnb-chain",
    protocolDefillamaSlug: "pancakeswap-amm",
    label: "USDT/WBNB (BNB Chain)",
    // Confirmed via GeckoTerminal's top-pools API and directly on-chain
    // (token0()/token1() called against the pool contract itself returned
    // these exact two addresses), 2026-08-18. Both tokens use 18 decimals
    // on BNB Chain - confirmed live via decimals() rather than assumed
    // (BSC-USD is 18, unlike Ethereum USDT's 6 - the same decimals gotcha
    // documented in app/api/wallet/balances/route.ts bit this class of bug
    // once already this session).
    poolAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
    tokens: [
      {
        address: "0x55d398326f99059ff775485246999027b3197955",
        symbol: "USDT",
        decimals: 18,
        coingeckoId: "tether",
      },
      {
        address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        symbol: "WBNB",
        decimals: 18,
        coingeckoId: "wbnb",
      },
    ],
  },
];

// A second, distinct category: protocols whose TVL isn't "sum of a pool
// contract's own token balances" but is still a single, unambiguous number
// the protocol's own contract exposes directly via a view function - no
// exchange-rate/debt/share-price accounting needed to interpret it, unlike
// lending or vault protocols. Liquid staking is the clearest fit: a
// liquid-staking token's issuing contract already tracks "total underlying
// staked" as its own canonical state (it has to, to compute the token's
// exchange rate), so reading that function directly is exactly as
// first-party and provably-correct as reading an AMM pool's own balance -
// just a different shape of "the contract's own accounting," not a weaker
// standard of evidence.
export interface VerifiedProtocolTvl {
  key: string;
  chainSlug: string;
  protocolDefillamaSlug: string;
  label: string;
  contractAddress: string;
  // Human-readable Solidity signature (parsed with viem's parseAbi), not a
  // raw selector - keeps each entry legible and lets viem compute the
  // correct selector itself rather than one being hand-copied/misremembered
  // into the config (confirmed the hard way while researching this exact
  // entry - a memorized selector for getTotalPooledEther() turned out to be
  // wrong; viem's own toFunctionSelector() computed the real one).
  functionSignature: string;
  decimals: number;
  // Prices whatever unit the function returns (e.g. "ethereum" for a
  // function returning a plain ETH amount) - not necessarily the liquid
  // staking token's own id, which can trade at a slight premium/discount to
  // its underlying during stress events rather than always at exact parity.
  coingeckoId: string;
}

export const VERIFIED_PROTOCOL_TVLS: VerifiedProtocolTvl[] = [
  {
    key: "lido-eth-steth",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "lido",
    label: "Total ETH staked (Lido)",
    // Confirmed live, 2026-08-19: name()/symbol() on this address return
    // "Liquid staked Ether 2.0"/"stETH" (also cross-checked against
    // CoinGecko's /coins/ethereum/contract/{address} lookup, which
    // resolves it to the "staked-ether" id). getTotalPooledEther() and
    // totalSupply() both returned ~9.54M ETH, matching each other exactly
    // as expected from stETH's 1:1-pegged design - a second, independent
    // on-chain confirmation of the same figure via a different call.
    contractAddress: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    functionSignature: "function getTotalPooledEther() view returns (uint256)",
    decimals: 18,
    coingeckoId: "ethereum",
  },
];
