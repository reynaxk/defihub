import Link from "next/link";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatPercent, formatUsd } from "@/lib/format";

export interface DistributionItem {
  key: string;
  label: string;
  value: number;
  // Omit for a non-navigable item (e.g. a category, which isn't its own
  // entity page) - renders a plain span instead of a Link.
  href?: string;
  // Omit for an item with no associated logo (e.g. a category) - EntityLogo
  // is skipped entirely rather than rendered with a placeholder.
  logoUrl?: string | null;
}

// Generalizes what was ChainDistribution (a protocol's per-chain TVL
// breakdown) into a labeled-progress-bar-list usable for any
// label+value breakdown - also replaces an inline duplicate of the same
// pattern that was hand-built directly inside app/chain/[slug]/page.tsx
// for its TVL-by-category breakdown.
export function DistributionBarList({
  items,
  emptyMessage,
  valueFormatter = formatUsd,
}: {
  items: DistributionItem[];
  emptyMessage: string;
  valueFormatter?: (n: number) => string;
}) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const total = items.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
        const share = total > 0 ? (item.value / total) * 100 : 0;
        const label = (
          <>
            {item.logoUrl !== undefined && <EntityLogo src={item.logoUrl} name={item.label} size={20} />}
            <span className="truncate">{item.label}</span>
          </>
        );
        return (
          <div key={item.key} className="flex items-center gap-3">
            {item.href ? (
              <Link
                href={item.href}
                className="flex w-36 shrink-0 items-center gap-2 font-medium hover:text-primary"
              >
                {label}
              </Link>
            ) : (
              <span className="flex w-36 shrink-0 items-center gap-2 font-medium">{label}</span>
            )}
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, share)}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {formatPercent(share)}
            </span>
            <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">
              {valueFormatter(item.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
