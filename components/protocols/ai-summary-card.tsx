"use client";

import { useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { Lightbulb, ShieldAlert, Sparkles, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface ProtocolSummarySections {
  overview: string;
  insights: string[];
  risks: string[];
  opportunities: string[];
}

interface Summary {
  sections: ProtocolSummarySections;
  model: string;
  createdAt: string;
}

function SectionList({
  icon: Icon,
  label,
  items,
  className,
}: {
  icon: typeof Lightbulb;
  label: string;
  items: string[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mt-4">
      <h3 className={`flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase ${className ?? "text-muted-foreground"}`}>
        <Icon className="size-3.5" />
        {label}
      </h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-sm text-foreground">
            <span className="text-muted-foreground">–</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiSummaryCard({
  slug,
  isSignedIn,
  aiAvailable,
  initialSummary,
}: {
  slug: string;
  isSignedIn: boolean;
  aiAvailable: boolean;
  initialSummary: Summary | null;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [isPending, startTransition] = useTransition();

  function generate() {
    startTransition(async () => {
      const res = await fetch(`/api/protocols/${slug}/summarize`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Couldn't generate summary");
        return;
      }
      const data = await res.json();
      setSummary(data.summary);
    });
  }

  if (!aiAvailable && !summary) {
    return null;
  }

  return (
    <Card className="mt-6 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Sparkles className="size-4" />
          AI summary
        </h2>
        {aiAvailable && isSignedIn && (
          <Button variant="outline" size="sm" onClick={generate} disabled={isPending}>
            {isPending ? "Generating…" : summary ? "Regenerate" : "Generate"}
          </Button>
        )}
      </div>

      {summary ? (
        <>
          <p className="mt-3 text-sm text-foreground">{summary.sections.overview}</p>
          <SectionList icon={Lightbulb} label="Insights" items={summary.sections.insights} />
          <SectionList
            icon={ShieldAlert}
            label="Risks"
            items={summary.sections.risks}
            className="text-destructive"
          />
          <SectionList
            icon={TrendingUp}
            label="Opportunities"
            items={summary.sections.opportunities}
            className="text-[var(--success-text)]"
          />
          <p className="mt-4 text-xs text-muted-foreground">
            Generated {formatDistanceToNow(new Date(summary.createdAt), { addSuffix: true })} · {summary.model}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {aiAvailable
            ? isSignedIn
              ? "Not generated yet. Click Generate for an AI-written overview of this protocol."
              : "Sign in to generate an AI-written overview of this protocol."
            : "AI summary unavailable."}
        </p>
      )}
    </Card>
  );
}
