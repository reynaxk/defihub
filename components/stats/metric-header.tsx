import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The large "headline number" pattern - a page's single most important
// metric, set apart from the denser MetricRow strip below it. Used for the
// homepage's global TVL and reusable anywhere else a page needs the same
// "one number matters most here" treatment.
export function MetricHeader({
  eyebrow,
  value,
  label,
  change,
  className,
}: {
  eyebrow?: string;
  value: ReactNode;
  label: string;
  change?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-x-5 gap-y-2", className)}>
      <div>
        {eyebrow && (
          <p className="text-xs font-medium tracking-[0.15em] text-muted-foreground uppercase">{eyebrow}</p>
        )}
        <p className="mt-1.5 font-mono text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl">{value}</p>
        <p className="mt-1 text-sm text-muted-foreground">{label}</p>
      </div>
      {change && <div className="pb-2.5">{change}</div>}
    </div>
  );
}
