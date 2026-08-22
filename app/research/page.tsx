import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ResearchPanel } from "@/components/research/research-panel";
import { isAiSummaryAvailable } from "@/lib/ai/protocol-summary";

export const metadata: Metadata = {
  title: "Research",
  description: "AI-powered research grounded in DeFiHub's own indexed on-chain data.",
};

const aiConfigured = isAiSummaryAvailable();

export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <div className="flex flex-col items-start gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
          <Sparkles className="size-3.5" />
          DeFiHub Research
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Ask DeFiHub, not a generic chatbot</h1>
        <p className="max-w-2xl text-muted-foreground">
          A research terminal that answers questions using DeFiHub&apos;s own indexed data - every figure links back
          to the chart or table it came from, and a question outside what DeFiHub can back with real data gets told
          so honestly, not guessed.
        </p>
      </div>

      <div className="mt-8">
        <ResearchPanel />
      </div>

      <Card className="mt-8 p-5">
        <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <Sparkles className="size-3.5" />
          Also available: per-protocol AI summaries
        </h2>
        <p className="mt-3 text-sm text-foreground">
          {aiConfigured
            ? "Every protocol page has an AI-generated summary - overview, insights, risks and opportunities - grounded in that protocol's own tracked metrics."
            : "AI summaries are built into every protocol page, but aren't currently configured on this deployment."}
        </p>
        {aiConfigured && (
          <Link href="/protocols" className="mt-3 inline-block text-sm text-primary hover:underline">
            Open a protocol to try it →
          </Link>
        )}
      </Card>
    </div>
  );
}
