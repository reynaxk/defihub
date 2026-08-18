// The hand-picked set of on-chain reads this feature verifies. Deliberately
// a fixed, short list - not auto-discovered - since each entry needs a human
// to have confirmed the contract address, chain, and TVL math actually apply.
// See docs/architecture.md "On-chain verification" for why this is scoped to
// AMM-style pools only (lending/staking/vault protocols need different
// accounting and are explicitly out of scope, regardless of how many entries
// this list grows to).

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
