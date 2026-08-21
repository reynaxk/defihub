import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A dense horizontal strip of label/value pairs - the "sophisticated
// horizontal information system" the terminal redesign calls for in place
// of a wall of individually-carded stat tiles. Wraps on narrow viewports
// rather than scrolling, since these are short label+value pairs, not a
// table.
export function MetricRow({
  items,
  className,
}: {
  items: { label: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-x-8 gap-y-4 border-y border-border/60 py-4", className)}>
      {items.map((item, i) => (
        <div key={i} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <span className="font-mono text-lg font-medium tabular-nums text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
