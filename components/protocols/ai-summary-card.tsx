"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function AiSummaryCard({
  slug,
  isSignedIn,
  aiAvailable,
  initialSummary,
}: {
  slug: string;
  isSignedIn: boolean;
  aiAvailable: boolean;
  initialSummary: { content: string; model: string; createdAt: string } | null;
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
    <div className="mt-6 rounded-lg border border-border bg-card p-4">
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
        <p className="mt-3 text-sm text-foreground">{summary.content}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {aiAvailable
            ? isSignedIn
              ? "Not generated yet. Click Generate for an AI-written overview of this protocol."
              : "Sign in to generate an AI-written overview of this protocol."
            : "AI summary unavailable."}
        </p>
      )}
    </div>
  );
}
