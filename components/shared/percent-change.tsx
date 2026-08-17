import { cn } from "@/lib/utils";
import { formatPercent } from "@/lib/format";

export function PercentChange({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null || Number.isNaN(value)) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }
  return (
    <span
      className={cn(value >= 0 ? "text-[var(--success-text)]" : "text-destructive", className)}
    >
      {formatPercent(value, { signed: true })}
    </span>
  );
}
