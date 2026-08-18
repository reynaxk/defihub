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
];
