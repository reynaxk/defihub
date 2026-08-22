// A "metric" is a real, sourced figure the answer cites - it always links
// back to the DeFiHub page that number came from, per the phase spec's
// "every factual metric should link back to available DeFiHub data"
// requirement. `href` is required, not optional: every producer in
// lib/research/engine.ts must resolve a real destination for every metric
// it emits (falling back to a broader-but-still-real page - e.g. a yield
// pool with no protocol links to its chain instead - rather than omitting
// the link), so this contract can't be silently violated by a future
// result builder forgetting one. `changeDirection` only drives color
// (up/down/neutral), it is never itself the fact - the label + value pair
// is.
export interface ResearchMetric {
  label: string;
  value: string;
  href: string;
  changeDirection?: "up" | "down" | "neutral";
}

export interface ResearchSection {
  heading: string;
  body: string;
  metrics?: ResearchMetric[];
}

export interface ResearchResult {
  query: string;
  matchedPattern: string;
  tldr: string;
  sections: ResearchSection[];
  generatedAt: string;
  // Surfaced whenever an answer's honesty depends on a constraint the reader
  // should know about (e.g. shallow local history depth, or that a figure is
  // TVL change rather than a directional flow) - never omitted to make an
  // answer read cleaner.
  dataNote?: string;
}
