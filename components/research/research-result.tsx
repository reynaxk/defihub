import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { ResearchMetric, ResearchResult as ResearchResultData } from "@/lib/research/types";
import { formatDate } from "@/lib/format";

function DirectionIcon({ direction }: { direction: ResearchMetric["changeDirection"] }) {
  if (direction === "up") return <ArrowUpRight className="size-3.5 text-[var(--success-text)]" aria-hidden="true" />;
  if (direction === "down") return <ArrowDownRight className="size-3.5 text-destructive" aria-hidden="true" />;
  if (direction === "neutral") return <Minus className="size-3.5 text-muted-foreground" aria-hidden="true" />;
  return null;
}

// `href` is required on ResearchMetric (see lib/research/types.ts) - every
// metric this renders is guaranteed a real destination, so this is always a
// link, never a conditional fallback to a bare, unsourced span.
function MetricPill({ metric }: { metric: ResearchMetric }) {
  return (
    <Link href={metric.href} className="block">
      <span className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:border-primary/50 hover:bg-muted">
        <DirectionIcon direction={metric.changeDirection} />
        <span className="flex flex-col">
          <span className="text-xs text-muted-foreground">{metric.label}</span>
          <span className="font-medium tabular-nums">{metric.value}</span>
        </span>
      </span>
    </Link>
  );
}

export function ResearchResultView({ result }: { result: ResearchResultData }) {
  return (
    <Card className="mt-6 p-5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-medium tracking-wide text-primary uppercase">TL;DR</span>
        <span className="text-xs text-muted-foreground">Generated {formatDate(result.generatedAt)}</span>
      </div>
      <p className="mt-2 text-base text-foreground">{result.tldr}</p>

      {result.sections.map((section) => (
        <div key={section.heading} className="mt-6 border-t border-border/60 pt-5">
          <h3 className="text-sm font-medium text-foreground">{section.heading}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{section.body}</p>
          {section.metrics && section.metrics.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {section.metrics.map((metric, i) => (
                <MetricPill key={`${metric.label}-${i}`} metric={metric} />
              ))}
            </div>
          )}
        </div>
      ))}

      {result.dataNote && (
        <p className="mt-6 border-t border-border/60 pt-4 text-xs text-muted-foreground">{result.dataNote}</p>
      )}

      <p className="mt-4 text-[11px] text-muted-foreground">
        Indexed data and calculated metrics only - every figure above comes directly from DeFiHub&apos;s own tracked data,
        computed the same way the linked page computes it. Nothing here is AI-generated.
      </p>
    </Card>
  );
}
