// A "metric" is a real, sourced figure the answer cites - it always links
// back to the DeFiHub page that number came from, per the phase spec's
// "every factual metric should link back to available DeFiHub data"
// requirement. `changeDirection` only drives color (up/down/neutral), it is
// never itself the fact - the label + value pair is.
export interface ResearchMetric {
  label: string;
  value: string;
  href?: string;
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
