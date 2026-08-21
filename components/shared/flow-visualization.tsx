import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface FlowEndpoint {
  label: string;
  href?: string;
  logoUrl?: string | null;
}

export interface FlowItem {
  key: string;
  source: FlowEndpoint;
  destination: FlowEndpoint;
  // Signed - positive/negative styling (green/red) is derived from this,
  // matching ChangeBadge's own convention elsewhere in the app.
  amount: number;
  changePercent?: number | null;
}

function Endpoint({ endpoint }: { endpoint: FlowEndpoint }) {
  const content = (
    <span className="flex items-center gap-1.5 truncate">
      {endpoint.logoUrl !== undefined && <EntityLogo src={endpoint.logoUrl} name={endpoint.label} size={18} />}
      <span className="truncate">{endpoint.label}</span>
    </span>
  );
  return endpoint.href ? (
    <Link href={endpoint.href} className="min-w-0 font-medium hover:text-primary">
      {content}
    </Link>
  ) : (
    <span className="min-w-0 font-medium">{content}</span>
  );
}

// Shared "A -> B, +/-$amount" pattern - one implementation reused for
// protocol capital flows, stablecoin flows, and bridge routes, rather than
// four ad-hoc versions of the same layout. Every current caller passes
// `flows: []` (none of those data sources exist yet - see each page's own
// comment on why), so `emptyState` is not a secondary/rare path here, it's
// the primary one today - built with the same care as the populated path,
// not an afterthought.
export function FlowVisualization({
  flows,
  emptyMessage,
  emptyDetail,
}: {
  flows: FlowItem[];
  emptyMessage: string;
  emptyDetail?: ReactNode;
}) {
  if (flows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border py-10 text-center">
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        {emptyDetail && <p className="max-w-md text-xs text-muted-foreground">{emptyDetail}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/60">
      {flows.map((flow) => {
        const positive = flow.amount >= 0;
        return (
          <div key={flow.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Endpoint endpoint={flow.source} />
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Endpoint endpoint={flow.destination} />
            </div>
            <div className="flex shrink-0 items-center gap-2 tabular-nums">
              <span className={cn("font-medium", positive ? "text-[var(--success-text)]" : "text-destructive")}>
                {positive ? "+" : ""}
                {formatUsd(flow.amount)}
              </span>
              {flow.changePercent != null && (
                <span className="text-xs text-muted-foreground">
                  ({positive ? "+" : ""}
                  {flow.changePercent.toFixed(1)}%)
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
