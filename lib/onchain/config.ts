// The hand-picked set of on-chain reads this feature verifies. Deliberately
// a fixed, short list - not auto-discovered - since each entry needs a human
// to have confirmed the contract addresses and the TVL math actually apply.
// See docs/architecture.md "On-chain verification" for why this is scoped so
// narrowly instead of a general indexer.

export interface VerifiedPool {
  key: string;
  protocolDefillamaSlug: string; // joins to `protocols.defillamaSlug` to attach the row
  label: string;
  poolAddress: string;
  token0: { address: string; symbol: string; decimals: number; coingeckoId: string };
  token1: { address: string; symbol: string; decimals: number; coingeckoId: string };
}

export const VERIFIED_POOLS: VerifiedPool[] = [
  {
    key: "uniswap-v3-eth-usdc-weth-005",
    protocolDefillamaSlug: "uniswap-v3",
    label: "USDC/WETH 0.05% (Ethereum)",
    // Confirmed against Etherscan/GeckoTerminal, 2026-08-17.
    poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    token0: {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
      coingeckoId: "usd-coin",
    },
    token1: {
      address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      symbol: "WETH",
      decimals: 18,
      coingeckoId: "weth",
    },
  },
];
