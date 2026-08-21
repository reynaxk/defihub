import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ComingSoon } from "@/components/shared/coming-soon";
import { Card } from "@/components/ui/card";
import { isAiSummaryAvailable } from "@/lib/ai/protocol-summary";

export const metadata: Metadata = {
  title: "Research",
  description: "AI-powered research grounded in DeFiHub's own indexed on-chain data.",
};

const aiConfigured = isAiSummaryAvailable();

export default function ResearchPage() {
  return (
    <ComingSoon
      icon={Sparkles}
      eyebrow="DeFiHub Research"
      title="Ask DeFiHub, not a generic chatbot"
      description="A research console that answers multi-protocol questions grounded entirely in DeFiHub's own indexed data - every cited figure linking straight back to the chart it came from - is on the roadmap."
      planned={[
        'Multi-entity questions like "Why did Aave TVL increase 18% over the last 30 days?"',
        "Structured answers - TL;DR, then a numbered breakdown of what actually moved",
        "Every cited number is clickable and opens the underlying DeFiHub chart",
        "Suggested prompts across protocols, chains, tokens and yields",
      ]}
    >
      <Card className="mt-8 p-5">
        <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <Sparkles className="size-3.5" />
          Available today
        </h2>
        <p className="mt-3 text-sm text-foreground">
          {aiConfigured
            ? "Every protocol page already has an AI-generated summary - overview, insights, risks and opportunities - grounded in that protocol's own tracked metrics."
            : "AI summaries are built into every protocol page, but aren't currently configured on this deployment."}
        </p>
        {aiConfigured && (
          <Link href="/protocols" className="mt-3 inline-block text-sm text-primary hover:underline">
            Open a protocol to try it →
          </Link>
        )}
      </Card>
    </ComingSoon>
  );
}
