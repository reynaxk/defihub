const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const fullUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function formatUsd(value: number | null | undefined, { compact = true } = {}): string {
  if (value == null || Number.isNaN(value)) return "—";
  return compact ? compactUsd.format(value) : fullUsd.format(value);
}

// Token prices are frequently well under $1 (many under $0.01) - a flat
// maximumFractionDigits of 2 (fine for TVL/fees, which are always large)
// would render most of them as a misleading "$0.00". Scale precision to
// magnitude instead so small-but-real prices stay visible.
const tokenPriceFormatters = [
  { min: 1, format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
  { min: 0.01, format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }) },
  { min: 0.0001, format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }) },
  { min: 0, format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 8 }) },
];

export function formatTokenPrice(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const tier = tokenPriceFormatters.find((t) => abs >= t.min) ?? tokenPriceFormatters[tokenPriceFormatters.length - 1];
  return tier.format.format(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return compactNumber.format(value);
}

export function formatPercent(value: number | null | undefined, { signed = false } = {}): string {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatApy(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}%`;
}
