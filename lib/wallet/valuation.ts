// Pure financial math extracted from app/api/wallet/balances/route.ts - no
// RPC/DB dependency, so the actual money math is directly unit-testable
// instead of only reachable through a route handler that needs live chain
// access to exercise.

export function computeValueUsd(balance: string, priceUsd: number | null): number | null {
  return priceUsd != null ? Number(balance) * priceUsd : null;
}

export interface UsdAggregate {
  total: number | null;
  // True when at least one of the input values is null - i.e. some held
  // asset has no tracked price. `total` still sums whatever IS priced
  // (excluded, never zeroed), but callers must surface this flag instead
  // of presenting that sum as if it were a complete total.
  isPartial: boolean;
}

// Only pass values for assets with a real (nonzero) balance - an unpriced
// zero-balance asset isn't "missing value," there's nothing there to miss.
export function aggregateUsdValues(values: (number | null)[]): UsdAggregate {
  const priced = values.filter((v): v is number => v != null);
  return {
    total: priced.length > 0 ? priced.reduce((sum, v) => sum + v, 0) : null,
    isPartial: priced.length < values.length,
  };
}
