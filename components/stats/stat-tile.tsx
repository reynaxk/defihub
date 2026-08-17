import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber, type AnimatedNumberFormat } from "@/components/stats/animated-number";

export function StatTile({
  label,
  value,
  icon: Icon,
  valueClassName,
  animate,
  customValue,
}: {
  label: string;
  value?: string;
  icon?: LucideIcon;
  valueClassName?: string;
  // Optional progressive enhancement: `value` is still required (and is
  // what renders with no JS), animate provides the raw number so the
  // client can count up to it instead of just displaying the string.
  animate?: { value: number; format: AnimatedNumberFormat };
  // Escape hatch for values that aren't a plain formatted string - e.g. a
  // colored PercentChange node. Takes priority over `value`/`animate`.
  customValue?: ReactNode;
}) {
  return (
    <div className="group rounded-lg border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon && <Icon className="size-4 transition-transform duration-200 group-hover:scale-110" />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums text-foreground", valueClassName)}>
        {customValue ?? (animate ? <AnimatedNumber value={animate.value} format={animate.format} /> : value)}
      </div>
    </div>
  );
}
