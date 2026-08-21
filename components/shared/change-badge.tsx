import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";

// The "+X.XX% 24H" chip used beside a page's primary metric (homepage
// global TVL, and every protocol/chain/token detail page's headline
// metric) - one shared definition rather than a per-page reimplementation.
export function ChangeBadge({ value, period }: { value: number | null | undefined; period?: string }) {
  if (value == null || Number.isNaN(value)) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  const positive = value >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium tabular-nums",
        positive ? "bg-[var(--success-text)]/10 text-[var(--success-text)]" : "bg-destructive/10 text-destructive",
      )}
    >
      {positive ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
      {formatPercent(value, { signed: true })}
      {period && <span className="ml-0.5 text-xs font-normal opacity-70">{period}</span>}
    </span>
  );
}
