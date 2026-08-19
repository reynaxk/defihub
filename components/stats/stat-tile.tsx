import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber, type AnimatedNumberFormat } from "@/components/stats/animated-number";
import { Card } from "@/components/ui/card";

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
  // `value` is the plain formatted string, rendered as-is whenever `animate`
  // is omitted or falsy (several call sites do exactly this - e.g. a null
  // data point where there's nothing real to count up to). When `animate`
  // IS provided, AnimatedNumber renders instead and `value` is not used for
  // that tile at all - it isn't a no-JS fallback (there's no <noscript>
  // wiring here, and this whole app already requires JS for its core
  // interactions - search, alerts, watchlist, sign-in), just a formatted
  // string some callers happen to also pass for symmetry with their
  // non-animated siblings.
  animate?: { value: number; format: AnimatedNumberFormat };
  // Escape hatch for values that aren't a plain formatted string - e.g. a
  // colored PercentChange node. Takes priority over `value`/`animate`.
  customValue?: ReactNode;
}) {
  return (
    <Card interactive className="p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon && <Icon className="size-4 transition-transform duration-200 group-hover/card:scale-110" />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums text-foreground", valueClassName)}>
        {customValue ?? (animate ? <AnimatedNumber value={animate.value} format={animate.format} /> : value)}
      </div>
    </Card>
  );
}
