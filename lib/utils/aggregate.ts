// Shared null-safe aggregation helper. A missing value means "unknown," not
// "zero" - summing with `?? 0` silently understates a total whenever any
// input is null, which is exactly wrong for figures like total TVL. This
// mirrors lib/wallet/valuation.ts's aggregateUsdValues (exclude unknowns,
// flag isPartial, never coerce to 0) generalized for non-wallet callers so
// that module doesn't need a second, unrelated responsibility.

export interface KnownAggregate {
  total: number | null;
  // True when at least one input is null - i.e. some part of the total is
  // unknown. `total` still sums whatever IS known (excluded, never zeroed),
  // but callers must surface this flag instead of presenting that sum as a
  // complete total.
  isPartial: boolean;
}

export function sumKnownValues(values: (number | null)[]): KnownAggregate {
  const known = values.filter((v): v is number => v != null);
  return {
    total: known.length > 0 ? known.reduce((sum, v) => sum + v, 0) : null,
    isPartial: known.length < values.length,
  };
}
