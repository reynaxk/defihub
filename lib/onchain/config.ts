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
// Human-readable Solidity signatures throughout (parsed with viem's
// parseAbi), never a raw selector - keeps each entry legible and lets viem
// compute the correct selector itself rather than one being hand-copied/
// misremembered into the config. Confirmed the hard way while researching
// the first entry below: a memorized selector for getTotalPooledEther()
// turned out to be wrong; viem's own toFunctionSelector() computed the
// real one.
export type VerifiedProtocolTvlRead =
  // One no-arg call returns the total directly - e.g. Lido's stETH, which
  // rebases by adjusting every holder's balance to keep a 1:1 peg, so the
  // contract already tracks "total ETH pooled" as one number.
  | { kind: "direct"; functionSignature: string }
  // Two independent no-arg calls, multiplied - e.g. Rocket Pool's rETH,
  // which instead keeps a fixed supply and an appreciating exchange rate,
  // so "total ETH backing" isn't one call, it's supply * rate. Confirmed
  // this is exactly what the contract's own conversion helper
  // (getEthValue(amount)) computes internally too, by calling
  // getEthValue(1 rETH) and checking it exactly matches getExchangeRate()
  // - not assumed from how the rebasing/exchange-rate distinction usually
  // works for this class of token.
  | {
      kind: "supply-times-rate";
      supplyFunctionSignature: string;
      rateFunctionSignature: string;
      // Fixed-point precision of each read's own return value - NOT
      // assumed equal to each other or to the entry's `decimals` (the
      // resolved unit's decimals, e.g. ETH's 18). They coincide for an
      // 18-decimals-everywhere token like rETH, but aren't guaranteed to
      // in general; verify-protocol-tvl.ts's descaling math needs all
      // three specified independently to stay correct if that ever
      // changes.
      supplyDecimals: number;
      rateDecimals: number;
    };

export interface VerifiedProtocolTvl {
  key: string;
  chainSlug: string;
  protocolDefillamaSlug: string;
  label: string;
  contractAddress: string;
  read: VerifiedProtocolTvlRead;
  decimals: number;
  // Prices whatever unit the read resolves to (e.g. "ethereum" for a
  // result denominated in plain ETH) - not necessarily the liquid staking
  // token's own id, which can trade at a slight premium/discount to its
  // underlying during stress events rather than always at exact parity.
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
    read: { kind: "direct", functionSignature: "function getTotalPooledEther() view returns (uint256)" },
    decimals: 18,
    coingeckoId: "ethereum",
  },
  // Rocket Pool's rETH was researched (2026-08-19) as the second real use
  // of the "supply-times-rate" read kind above. The exchange-rate read
  // itself checked out (totalSupply() * getExchangeRate() = ~374,526 ETH,
  // internally consistent and matching getEthValue(totalSupply) exactly),
  // but it landed ~29% below DefiLlama's published TVL ($717.4M vs
  // $1.006B). Chased this down rather than leaving it a mystery: read
  // DefiLlama's actual open-source adapter
  // (DefiLlama-Adapters/projects/rocketpool/index.js) instead of guessing,
  // and it turns out rETH's exchange rate was never the right read at all
  // - Rocket Pool's real TVL definition is idle ETH (rETH's own balance +
  // rocketDepositPool.getBalance()) + legacy minipool count * 32 ETH +
  // a newer "megapool" component. The exchange rate only reflects the
  // portion of each minipool's 32 ETH sourced from rETH depositors - it
  // excludes node operators' own co-invested bond capital, which is real
  // protocol TVL but never backs rETH.
  //
  // Recomputed with the correct components (RocketStorage-resolved
  // rocketDepositPool/rocketMinipoolManager addresses, confirmed against
  // the known rETH address before trusting them): idle ETH + deposit pool
  // + 14,297 legacy minipools * 32 ETH = ~457,536 ETH (~$877M) - closes
  // most of the gap (29% -> ~13% low) and confirms the theory. The
  // remaining piece is the "megapool" component, which isn't a single
  // accounting call: it requires enumerating every node operator
  // (getNodeCount()/getNodeAt()), checking each for a deployed megapool,
  // and summing active validators per one found - a genuine multi-entity
  // computation, not a different shape of "the contract's own number."
  // That's the same category boundary already excluding lending
  // protocols, not a new exception - so this stays unshipped rather than
  // either guessing at the megapool piece or quietly serving the
  // still-~13%-low three-component figure as if it were the full total.
  {
    key: "aave-v3-eth-ausdc",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "aave-v3",
    // Deliberately scoped to exactly what this read measures - one asset's
    // supplied liquidity in one market, not "Aave V3 TVL" (which spans many
    // assets/chains and nets borrows/utilization, a genuinely harder
    // multi-asset accounting problem this single read does not solve).
    label: "USDC supplied to Aave V3 (Ethereum)",
    // A lending-market aToken is a third architecture (alongside AMM pools
    // and Lido's liquid-staking token above), but this specific read still
    // fits the "direct" kind rather than needing new accounting: Aave V3's
    // aTokens rebase 1:1 with the underlying asset supplied to that
    // reserve (same shape as stETH above), so totalSupply() on the aToken
    // *is* "total USDC supplied," not an exchange-rate-adjusted figure
    // needing further interpretation.
    //
    // Verified live, 2026-08-20, two independent ways:
    // (1) name()/symbol()/decimals() on this address returned "Aave
    //     Ethereum USDC"/"aEthUSDC"/6 (6 matches USDC's own decimals(),
    //     also confirmed live - correct, since an aToken mirrors its
    //     underlying's decimals). UNDERLYING_ASSET_ADDRESS() returned
    //     0xA0b8...6eB48, an exact match for this app's own already-
    //     verified USDC address (lib/onchain/config.ts's VERIFIED_POOLS).
    // (2) Independently, calling the real Aave V3 Pool contract itself
    //     (0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2) via
    //     getReserveData(USDC) returned this exact same address as its
    //     aTokenAddress - the protocol's own live on-chain state, not just
    //     the address-book source the candidate address first came from
    //     (bgd-labs/aave-address-book, the same registry Aave governance
    //     tooling itself relies on).
    // totalSupply() returned ~2.18B USDC at the time of verification - a
    // plausible order of magnitude for one of the largest USDC lending
    // markets in DeFi, not a red flag like the Rocket Pool figure above.
    contractAddress: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
    read: { kind: "direct", functionSignature: "function totalSupply() view returns (uint256)" },
    decimals: 6,
    coingeckoId: "usd-coin",
  },
];

// ---------------------------------------------------------------------------
// ERC-4626 tokenized vaults - Phase 5.2
//
// A third, genuinely reusable category (alongside AMM pools above and
// single-value protocol accounting further up): ERC-4626 is a standardized
// interface (EIP-4626) that any compliant vault implements identically -
// `asset()` returns the one underlying token address, `totalAssets()`
// returns that vault's total holdings of it, denominated in the
// underlying's own smallest unit. Unlike VERIFIED_PROTOCOL_TVLS' "direct"
// entries above (each hand-written against that specific protocol's own
// function names - getTotalPooledEther(), totalSupply()), one adapter
// (lib/onchain/verify-vault.ts) reads every entry here through the exact
// same two function signatures - onboarding another compliant vault is a
// config entry, not new code, which is the whole point of building this as
// a real adapter rather than another one-off.
//
// TVL calculation reuses computePoolTvl (verify-pool.ts) unmodified: an
// ERC-4626 vault's TVL is exactly the N=1 case of "sum of balance * price
// across tokens this contract holds" - totalAssets() standing in for a
// pool's balanceOf, and the vault's own contract address standing in for
// the pool address. Same exact BigInt fixed-point arithmetic, same
// explicit-failure-over-fabrication contract, not a reimplementation.
//
// Each entry's underlying asset is inlined (not a list, unlike
// VerifiedPool.tokens) because ERC-4626 vaults are single-asset by
// definition - there is no N-token case to support here.
export interface VerifiedVault {
  key: string;
  chainSlug: string;
  protocolDefillamaSlug: string;
  label: string;
  vaultAddress: string;
  underlyingAsset: {
    address: string;
    symbol: string;
    decimals: number;
    coingeckoId: string;
  };
}

export const VERIFIED_VAULTS: VerifiedVault[] = [
  {
    key: "sdai-ethereum",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "sky",
    label: "Savings Dai (sDAI) total assets",
    // Cross-checked two independent ways, 2026-08-25: (1) Etherscan tags
    // this contract "ERC-4626" directly and its own page states it wraps
    // DAI via the Sky Protocol's Dai Savings Rate module; (2) the
    // constructor arguments recorded on that same page show the wrapped
    // asset address as an exact match for DAI's own well-known mainnet
    // address (0x6b175474e89094c44da98b954eedeac495271d0f) - the
    // underlyingAsset.address below.
    vaultAddress: "0x83f20f44975d03b1b09e64809b757c47f942beea",
    underlyingAsset: {
      address: "0x6b175474e89094c44da98b954eedeac495271d0f",
      symbol: "DAI",
      decimals: 18,
      coingeckoId: "dai",
    },
  },
  {
    key: "susde-ethereum",
    chainSlug: "ethereum",
    protocolDefillamaSlug: "ethena",
    label: "Staked USDe (sUSDe) total assets",
    // Cross-checked two independent ways, 2026-08-25: (1) Etherscan tags
    // this contract "ERC-4626" directly; (2) the underlying asset address
    // recorded in that contract's own constructor arguments/vault
    // functions is an exact match for USDe's own address
    // (0x4c9edd5852cd905f086c759e8383e09bff1e68b3) - the
    // underlyingAsset.address below. coingeckoId matches this app's own
    // existing usage for USDe (lib/database/queries/stablecoins.ts's
    // KNOWN_STABLECOIN_IDS already tracks "ethena-usde").
    vaultAddress: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
    underlyingAsset: {
      address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
      symbol: "USDe",
      decimals: 18,
      coingeckoId: "ethena-usde",
    },
  },
];
