// Single source of truth for the /api/wallet/balances response shape,
// shared between the route (app/api/wallet/balances/route.ts) and the
// client component that consumes it (components/wallet/wallet-dashboard.tsx)
// - previously duplicated independently in both places, which meant a
// shape change on one side wasn't guaranteed to be caught on the other.
// Type-only, so importing this into a "use client" component has zero
// runtime cost or server-code leakage risk.

export interface TokenBalance {
  symbol: string;
  address: string;
  logoUrl: string | null;
  balance: string;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface ChainBalanceResult {
  chainSlug: string;
  chainName: string;
  nativeToken: string;
  nativeBalance: string;
  nativePriceUsd: number | null;
  nativeValueUsd: number | null;
  tokenBalances: TokenBalance[];
  // null (not 0) when there's a real balance but no tracked price covers any
  // of it - a $0 total would read as "worth nothing" instead of "unknown".
  chainTotalUsd: number | null;
  // True when this chain holds at least one asset (native or token) with no
  // tracked price - chainTotalUsd still sums whatever IS priced, this flag
  // is what tells the UI that number is not the whole picture.
  isPartial: boolean;
}

export interface ChainBalanceError {
  chainSlug: string;
  chainName: string;
  error: string;
}

export type ChainResult = ChainBalanceResult | ChainBalanceError;

export interface WalletBalancesResponse {
  address: string;
  chains: ChainResult[];
  totalUsd: number | null;
  isPartial: boolean;
}
