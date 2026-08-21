"use client";

import { useState, type FormEvent } from "react";
import { Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ResearchResultView } from "@/components/research/research-result";
import type { ResearchResult } from "@/lib/research/types";

const SUGGESTED_PROMPTS = [
  "Why is Ethereum TVL rising?",
  "Which protocols are gaining liquidity?",
  "Where is capital flowing?",
  "Which chains are growing fastest?",
  "What changed this week?",
  "Which yields have become attractive?",
];

type Status = "idle" | "loading" | "error" | "unmatched" | "success";

export function ResearchPanel() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  async function runQuery(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setStatus("loading");
    setLastQuery(trimmed);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const data = (await res.json()) as { result: ResearchResult | null };
      if (!data.result) {
        setResult(null);
        setStatus("unmatched");
        return;
      }
      setResult(data.result);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runQuery(query);
  }

  function handlePrompt(prompt: string) {
    setQuery(prompt);
    void runQuery(prompt);
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask about a chain, protocol, or trend..."
          aria-label="Research question"
          className="h-10"
        />
        <Button type="submit" disabled={status === "loading" || !query.trim()} className="h-10 shrink-0 px-4">
          <Sparkles className="size-4" aria-hidden="true" />
          Ask
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handlePrompt(prompt)}
            disabled={status === "loading"}
          >
            {prompt}
          </Button>
        ))}
      </div>

      {status === "loading" && (
        <Card className="mt-6 p-5">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-3 h-5 w-3/4" />
          <Skeleton className="mt-6 h-4 w-32" />
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        </Card>
      )}

      {status === "error" && (
        <Card className="mt-6 flex items-center gap-2 p-5 text-sm text-destructive">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          Something went wrong answering that. Try again in a moment.
        </Card>
      )}

      {status === "unmatched" && (
        <Card className="mt-6 p-5">
          <p className="text-sm text-foreground">
            DeFiHub Research doesn&apos;t have a grounded answer for &quot;{lastQuery}&quot; yet - it only answers
            questions it can back with real, indexed data, rather than guessing.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Try one of the suggested prompts above, or mention a specific chain or protocol DeFiHub tracks (e.g. &quot;Why
            is Arbitrum TVL rising?&quot; or &quot;Why did Aave grow?&quot;).
          </p>
        </Card>
      )}

      {status === "success" && result && <ResearchResultView result={result} />}
    </div>
  );
}
