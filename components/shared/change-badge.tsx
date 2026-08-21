import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";

export type ChangeDirection = "positive" | "negative" | "neutral";

// Pure and exported separately from the component so it's unit-testable
// without a DOM/render environment (this codebase's tests are either pure
// functions or real-Postgres integration tests - no jsdom/testing-library
// setup exists, and adding one just to render this one component would be
// disproportionate). `null` means "not a renderable change at all" - the
// placeholder state; every other case gets a real formatted percentage.
export function classifyChange(value: number | null | undefined): ChangeDirection | null {
  // Rejects null/undefined, NaN, and +-Infinity in one check - a computed
  // change (a delta divided by a prior value) can legitimately produce any
  // of those from real data (e.g. a prior value of exactly 0), and none of
  // them are a renderable percentage. `value == null` first, not just
  // Number.isFinite alone, so TypeScript narrows `value` to `number` below -
  // Number.isFinite has no type predicate of its own to do that.
  if (value == null || !Number.isFinite(value)) return null;
  // Exactly 0 is a real, valid change - "no movement" - not the same as
  // "no data" (handled above) and not directionally positive or negative.
  if (value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

// The "+X.XX% 24H" chip used beside a page's primary metric (homepage
// global TVL, and every protocol/chain/token detail page's headline
// metric) - one shared definition rather than a per-page reimplementation.
export function ChangeBadge({ value, period }: { value: number | null | undefined; period?: string }) {
  const direction = classifyChange(value);
  if (direction == null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  // value is narrowed to `number` by classifyChange returning non-null,
  // but that narrowing doesn't cross the function boundary for TypeScript -
  // safe to assert here since direction's only non-null values require it.
  const numericValue = value as number;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium tabular-nums",
        direction === "positive" && "bg-[var(--success-text)]/10 text-[var(--success-text)]",
        direction === "negative" && "bg-destructive/10 text-destructive",
        direction === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {direction === "positive" && <ArrowUp className="size-3.5" />}
      {direction === "negative" && <ArrowDown className="size-3.5" />}
      {formatPercent(numericValue, { signed: true })}
      {period && <span className="ml-0.5 text-xs font-normal opacity-70">{period}</span>}
    </span>
  );
}
