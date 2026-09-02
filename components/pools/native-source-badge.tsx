import { cn } from "@/lib/utils";
import type { NativeMetricSource } from "@/lib/database/queries/native-pools";

// Phase 5.12, Part 6: "do NOT plaster huge ugly badges everywhere... use a
// polished terminal-style treatment" - a small monospace tag rather than
// the app's normal pill Badge component, deliberately visually distinct
// from a status/severity badge (this isn't "good/bad," it's "where did
// this number come from"). Same four-way vocabulary everywhere this
// concept appears (NativeMetricSource, native-pools.ts) - a metric is
// never shown without one of these four words attached somewhere nearby.
const LABEL: Record<NativeMetricSource, string> = {
  NATIVE: "native",
  HYBRID: "hybrid",
  EXTERNAL: "external",
  UNAVAILABLE: "unavailable",
};

const STYLE: Record<NativeMetricSource, string> = {
  NATIVE: "text-emerald-600 dark:text-emerald-400",
  HYBRID: "text-amber-600 dark:text-amber-400",
  EXTERNAL: "text-muted-foreground",
  UNAVAILABLE: "text-muted-foreground/60",
};

export function NativeSourceBadge({ source, className }: { source: NativeMetricSource; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider", STYLE[source], className)}
      title={sourceTitle(source)}
    >
      <span aria-hidden className="opacity-70">
        {"//"}
      </span>
      {LABEL[source]}
    </span>
  );
}

function sourceTitle(source: NativeMetricSource): string {
  switch (source) {
    case "NATIVE":
      return "Computed entirely from DeFiHub's own on-chain reads - no external price provider involved.";
    case "HYBRID":
      return "Computed partly from DeFiHub's own on-chain reads and partly from an external price provider.";
    case "EXTERNAL":
      return "Computed using an external price provider - not yet independently priced on-chain.";
    case "UNAVAILABLE":
      return "No reliable observation exists yet.";
  }
}
