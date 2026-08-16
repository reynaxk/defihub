import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatTile({
  label,
  value,
  icon: Icon,
  valueClassName,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon && <Icon className="size-4" />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums text-foreground", valueClassName)}>{value}</div>
    </div>
  );
}
