import { getTopChains, type ChainListItem } from "@/lib/database/queries/chains";
import {
  getProtocolChainBreakdown,
  getProtocolsList,
  getTopProtocols,
  type ProtocolListItem,
} from "@/lib/database/queries/protocols";
import { getGlobal24hTotals } from "@/lib/database/queries/protocols";
import { getYieldPools } from "@/lib/database/queries/yields";
import { CAUTION_APY, HIGH_RISK_APY } from "@/lib/yields/risk-thresholds";
import { formatApy, formatPercent, formatUsd } from "@/lib/format";
import type { ResearchMetric, ResearchResult, ResearchSection } from "./types";

// DeFiHub Research answers a fixed set of question *patterns* with real,
// queried data - it is not a free-text LLM chat. Every number in every
// answer traces back to one of the same query functions the rest of the app
// already uses (getTopChains, getProtocolsList, getYieldPools, ...), so an
// answer can never say anything the corresponding DeFiHub page couldn't
// also show. A query that matches no known pattern gets an honest "not
// understood" result (null) rather than a guessed answer - see
// runResearchQuery's final fallback.

const YIELD_MIN_TVL_USD = 100_000;
const TOP_N = 6;

function directionOf(value: number | null | undefined): "up" | "down" | "neutral" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "up" : "down";
}

function chainMetric(chain: ChainListItem): ResearchMetric {
  return {
    label: chain.name,
    value: `${formatPercent(chain.change7d, { signed: true })} 7D · ${formatUsd(chain.tvl)} TVL`,
    href: `/chain/${chain.slug}`,
    changeDirection: directionOf(chain.change7d),
  };
}

function protocolMetric(protocol: ProtocolListItem, changeField: "tvlChange1d" | "tvlChange7d" = "tvlChange7d"): ResearchMetric {
  const change = protocol[changeField];
  const label = changeField === "tvlChange7d" ? "7D" : "24H";
  return {
    label: protocol.name,
    value: `${formatPercent(change, { signed: true })} ${label} · ${formatUsd(protocol.tvl)} TVL`,
    href: `/protocol/${protocol.slug}`,
    changeDirection: directionOf(change),
  };
}

// Ranking "movers" by raw percent change surfaces noise - a protocol going
// from $500K to $8M TVL (+1500%) didn't move a $41B chain's needle the way
// a protocol going from $5B to $5.1B (+2%) did. This estimates the actual
// dollar delta implied by tvlChange7d (current = previous * (1 + c/100), so
// delta = current - previous = current*c/(100+c)) so "top movers" ranks by
// real economic weight instead. c <= -100 would imply a zero/undefined
// previous value - excluded rather than producing a nonsensical delta.
function estimatedDollarChange(tvl: number | null, changePercent: number | null): number | null {
  if (tvl == null || changePercent == null || changePercent <= -100) return null;
  return (tvl * changePercent) / (100 + changePercent);
}

function rankProtocolsByDollarChange(
  items: ProtocolListItem[],
  take: number,
  order: "desc" | "asc" = "desc",
): ProtocolListItem[] {
  return items
    .map((p) => ({ p, delta: estimatedDollarChange(p.tvl, p.tvlChange7d) }))
    .filter((x): x is { p: ProtocolListItem; delta: number } => x.delta != null)
    .sort((a, b) => (order === "desc" ? b.delta - a.delta : a.delta - b.delta))
    .slice(0, take)
    .map((x) => x.p);
}

// Candidate pool for dollar-weighted ranking - large enough that genuinely
// significant movers (even ones outside the top TVL bracket) are included,
// without fetching every tracked protocol.
const MOVER_CANDIDATE_POOL = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word matching only - a naive `query.includes(name)` matched short
// entity names *inside* unrelated words (protocol "Re" inside "protocols
// ARE gaining", protocol "cap" inside "CAPital flowing"), silently routing
// generic questions into an unrelated protocol's trend answer. \b anchors
// require an actual word boundary on both sides, so "re"/"cap" no longer
// match mid-word.
function mentionsWholeWord(query: string, name: string): boolean {
  if (!name.trim()) return false;
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(query);
}

async function findEntityMention(
  query: string,
): Promise<{ type: "chain"; chain: ChainListItem } | { type: "protocol"; protocol: ProtocolListItem } | null> {
  const chains = await getTopChains();
  const chainMatches = chains
    .filter((c) => mentionsWholeWord(query, c.name) || mentionsWholeWord(query, c.slug))
    .sort((a, b) => b.name.length - a.name.length);
  if (chainMatches.length > 0) return { type: "chain", chain: chainMatches[0] };

  const protocols = await getTopProtocols(150);
  const protocolMatches = protocols
    .filter((p) => mentionsWholeWord(query, p.name))
    .sort((a, b) => b.name.length - a.name.length);
  if (protocolMatches.length > 0) return { type: "protocol", protocol: protocolMatches[0] };

  return null;
}

async function answerChainTrend(query: string, chain: ChainListItem): Promise<ResearchResult> {
  const direction = directionOf(chain.change7d);
  const directionWord = direction === "up" ? "up" : direction === "down" ? "down" : "roughly flat";

  const candidates = await getProtocolsList({
    chainSlug: chain.slug,
    sortBy: "tvl",
    pageSize: MOVER_CANDIDATE_POOL,
  });
  const movers = rankProtocolsByDollarChange(candidates.items, TOP_N, "desc");

  const sections: ResearchSection[] = [
    {
      heading: "TVL trend",
      body: `${chain.name}'s TVL is ${directionWord} over the last 7 days.`,
      metrics: [
        { label: "Current TVL", value: formatUsd(chain.tvl), href: `/chain/${chain.slug}` },
        {
          label: "24H change",
          value: formatPercent(chain.change24h, { signed: true }),
          href: `/chain/${chain.slug}`,
          changeDirection: directionOf(chain.change24h),
        },
        {
          label: "7D change",
          value: formatPercent(chain.change7d, { signed: true }),
          href: `/chain/${chain.slug}`,
          changeDirection: directionOf(chain.change7d),
        },
        {
          label: "30D change",
          value: formatPercent(chain.change30d, { signed: true }),
          href: `/chain/${chain.slug}`,
          changeDirection: directionOf(chain.change30d),
        },
      ],
    },
  ];

  sections.push(
    movers.length > 0
      ? {
          heading: `Top protocol movers on ${chain.name}`,
          body: `The protocols on ${chain.name} with the largest estimated dollar TVL gain over 7 days - the ones that actually moved the chain's total, not just the biggest percentage swings.`,
          metrics: movers.map((p) => protocolMetric(p, "tvlChange7d")),
        }
      : {
          heading: `Top protocol movers on ${chain.name}`,
          body: `No protocol-level 7-day change data is available for ${chain.name} yet.`,
        },
  );

  return {
    query,
    matchedPattern: "chain-trend",
    tldr: `${chain.name}'s TVL is ${formatPercent(chain.change7d, { signed: true })} over the last 7 days, now at ${formatUsd(chain.tvl)}.`,
    sections,
    generatedAt: new Date().toISOString(),
  };
}

async function answerProtocolTrend(query: string, protocol: ProtocolListItem): Promise<ResearchResult> {
  const breakdown = await getProtocolChainBreakdown(protocol.id);

  const sections: ResearchSection[] = [
    {
      heading: "TVL trend",
      body: `${protocol.name}'s own tracked TVL change, sourced from DefiLlama's pre-computed figures.`,
      metrics: [
        { label: "Current TVL", value: formatUsd(protocol.tvl), href: `/protocol/${protocol.slug}` },
        {
          label: "24H change",
          value: formatPercent(protocol.tvlChange1d, { signed: true }),
          href: `/protocol/${protocol.slug}`,
          changeDirection: directionOf(protocol.tvlChange1d),
        },
        {
          label: "7D change",
          value: formatPercent(protocol.tvlChange7d, { signed: true }),
          href: `/protocol/${protocol.slug}`,
          changeDirection: directionOf(protocol.tvlChange7d),
        },
      ],
    },
  ];

  sections.push(
    breakdown.length > 0
      ? {
          heading: "Where that TVL sits today",
          body: `${protocol.name}'s current TVL split by chain (a present-state distribution, not a growth attribution).`,
          metrics: breakdown
            .slice(0, TOP_N)
            .map((b) => ({ label: b.chainName, value: formatUsd(b.tvl), href: `/chain/${b.chainSlug}` })),
        }
      : {
          heading: "Where that TVL sits today",
          body: `No per-chain TVL breakdown is available for ${protocol.name} yet.`,
        },
  );

  return {
    query,
    matchedPattern: "protocol-trend",
    tldr: `${protocol.name}'s TVL is ${formatPercent(protocol.tvlChange7d, { signed: true })} over the last 7 days, now at ${formatUsd(protocol.tvl)}.`,
    sections,
    generatedAt: new Date().toISOString(),
    dataNote:
      "DeFiHub's own locally-tracked per-chain history only goes back a couple of days, so a chain-by-chain breakdown of what specifically drove this change isn't available - the trend figures above come from DefiLlama's own pre-computed change metrics instead, which aren't limited by that.",
  };
}

async function answerProtocolLiquidity(query: string): Promise<ResearchResult> {
  const candidates = await getTopProtocols(MOVER_CANDIDATE_POOL);
  const gainers = rankProtocolsByDollarChange(candidates, TOP_N, "desc");

  return {
    query,
    matchedPattern: "protocol-liquidity",
    tldr:
      gainers.length > 0
        ? `${gainers[0].name} is leading TVL gains this week, up ${formatPercent(gainers[0].tvlChange7d, { signed: true })}.`
        : "No protocols show a positive 7-day TVL change right now.",
    sections: [
      {
        heading: "Top TVL gainers (7D)",
        body: "Protocols ranked by estimated dollar TVL gain over 7 days - the closest real signal DeFiHub has to \"gaining liquidity\".",
        metrics: (gainers.length > 0 ? gainers : candidates.slice(0, TOP_N)).map((p) => protocolMetric(p, "tvlChange7d")),
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

// $1M floor keeps this ranking on chains with enough real TVL that a percent
// move means something - without it, a chain that went from $500 to $50,000
// technically posts a +9900% figure that isn't a meaningful "fastest-growing"
// signal, unlike the dollar-weighted protocol rankings above (chains are a
// small, curated set, not thousands of long-tail entries, so a floor rather
// than a full dollar-delta ranking is enough here).
const FASTEST_CHAIN_MIN_TVL = 1_000_000;

async function answerFastestChains(query: string): Promise<ResearchResult> {
  const chains = await getTopChains();
  const ranked = [...chains]
    .filter((c) => c.change7d != null && (c.tvl ?? 0) >= FASTEST_CHAIN_MIN_TVL)
    .sort((a, b) => (b.change7d ?? 0) - (a.change7d ?? 0))
    .slice(0, TOP_N);

  return {
    query,
    matchedPattern: "fastest-chains",
    tldr:
      ranked.length > 0
        ? `${ranked[0].name} is growing fastest over the last 7 days, up ${formatPercent(ranked[0].change7d, { signed: true })}.`
        : "No chains have 7-day change data available right now.",
    sections: [
      {
        heading: "Fastest-growing chains (7D)",
        body: "Chains ranked by 7-day TVL change.",
        metrics: ranked.map(chainMetric),
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

async function answerCapitalFlow(query: string): Promise<ResearchResult> {
  const [chains, protocolCandidates] = await Promise.all([getTopChains(), getTopProtocols(MOVER_CANDIDATE_POOL)]);
  const topChains = [...chains]
    .filter((c) => c.change7d != null && (c.tvl ?? 0) >= FASTEST_CHAIN_MIN_TVL)
    .sort((a, b) => (b.change7d ?? 0) - (a.change7d ?? 0))
    .slice(0, TOP_N);
  const topProtocols = rankProtocolsByDollarChange(protocolCandidates, TOP_N, "desc");

  return {
    query,
    matchedPattern: "capital-flow",
    tldr:
      "DeFiHub doesn't track directional capital flows between chains or protocols yet - here's where TVL is growing fastest instead, the closest real signal currently available.",
    sections: [
      {
        heading: "Chains with the biggest TVL gains (7D)",
        body: "Ranked by 7-day TVL change, not a traced transfer of funds.",
        metrics: topChains.map(chainMetric),
      },
      {
        heading: "Protocols with the biggest TVL gains (7D)",
        body: "Ranked by estimated dollar TVL gain, not a traced transfer of funds.",
        metrics: topProtocols.map((p) => protocolMetric(p, "tvlChange7d")),
      },
    ],
    generatedAt: new Date().toISOString(),
    dataNote:
      "These figures reflect independent TVL snapshots per chain/protocol, not a traced movement of funds - DeFiHub has no bridge or transfer-tracking data pipeline yet, so an actual capital-flow map isn't something it can honestly show.",
  };
}

async function answerAttractiveYields(query: string): Promise<ResearchResult> {
  const pools = await getYieldPools({
    sortBy: "apy",
    sortDir: "desc",
    minTvl: YIELD_MIN_TVL_USD,
    // Excludes >=HIGH_RISK_APY pools in the query itself, not only after
    // fetching: getYieldPools caps at UNPAGED_MAX_ROWS (2000) and this is
    // sorted apy-desc, so without a DB-level ceiling, 2000+ junk/broken
    // high-APY pools could fill the entire fetched window before any
    // eligible pool is ever returned, hiding real yields ranked below them.
    // maxApy is an inclusive <=; the client-side `< HIGH_RISK_APY` filter
    // below stays as the exact (strict) boundary.
    maxApy: HIGH_RISK_APY,
  });
  const screened = pools.filter((p) => p.apy != null && p.apy < HIGH_RISK_APY).slice(0, TOP_N);

  return {
    query,
    matchedPattern: "attractive-yields",
    tldr:
      screened.length > 0
        ? `${screened[0].symbol} on ${screened[0].protocolName ?? "an unnamed protocol"} leads at ${formatApy(screened[0].apy)} APY with ${formatUsd(screened[0].tvlUsd)} TVL.`
        : `No pools with at least ${formatUsd(YIELD_MIN_TVL_USD)} TVL are currently tracked.`,
    sections: [
      {
        heading: `Top yields (≥${formatUsd(YIELD_MIN_TVL_USD)} TVL)`,
        body: `Pools with at least ${formatUsd(YIELD_MIN_TVL_USD)} in tracked TVL, ranked by APY. Pools flagged ⚠ are above ${CAUTION_APY}% APY - often real, but typically driven by reward-token emissions or thin liquidity rather than organic yield.`,
        metrics: screened.map((p) => ({
          label: `${p.symbol}${p.protocolName ? ` · ${p.protocolName}` : ""}`,
          value: `${p.apy != null && p.apy >= CAUTION_APY ? "⚠ " : ""}${formatApy(p.apy)} APY · ${formatUsd(p.tvlUsd)} TVL`,
          href: p.protocolSlug ? `/protocol/${p.protocolSlug}` : undefined,
        })),
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

async function answerWeeklyDigest(query: string): Promise<ResearchResult> {
  const [chains, protocolCandidates, totals] = await Promise.all([
    getTopChains(),
    getTopProtocols(MOVER_CANDIDATE_POOL),
    getGlobal24hTotals(),
  ]);

  const rankedChains = [...chains]
    .filter((c) => c.change7d != null && (c.tvl ?? 0) >= FASTEST_CHAIN_MIN_TVL)
    .sort((a, b) => (b.change7d ?? 0) - (a.change7d ?? 0));
  const chainGainers = rankedChains.slice(0, 3);
  const chainLosers = rankedChains.slice(-3).reverse();
  const gainerProtocols = rankProtocolsByDollarChange(protocolCandidates, 3, "desc");
  const loserProtocols = rankProtocolsByDollarChange(protocolCandidates, 3, "asc");

  return {
    query,
    matchedPattern: "weekly-digest",
    tldr:
      chainGainers.length > 0
        ? `${chainGainers[0].name} led chain-level TVL growth this week (${formatPercent(chainGainers[0].change7d, { signed: true })}), while total tracked 24H protocol volume stands at ${formatUsd(totals.volume24h)}.`
        : `Total tracked 24H protocol volume stands at ${formatUsd(totals.volume24h)}.`,
    sections: [
      {
        heading: "Global activity (24H)",
        body: "Summed across every protocol DeFiHub tracks, at the latest sync - the same figures shown on the homepage.",
        metrics: [
          { label: "Volume", value: formatUsd(totals.volume24h), href: "/" },
          { label: "Fees", value: formatUsd(totals.fees24h), href: "/" },
          { label: "Revenue", value: formatUsd(totals.revenue24h), href: "/" },
        ],
      },
      {
        heading: "Chain movers (7D)",
        body: "Biggest gainers and decliners by 7-day TVL change.",
        metrics: [...chainGainers, ...chainLosers].map(chainMetric),
      },
      {
        heading: "Protocol movers (7D)",
        body: "Biggest gainers and decliners by estimated dollar TVL change.",
        metrics: [...gainerProtocols, ...loserProtocols].map((p) => protocolMetric(p, "tvlChange7d")),
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

interface KeywordMatcher {
  name: string;
  test: (q: string) => boolean;
  run: (query: string) => Promise<ResearchResult>;
}

const KEYWORD_MATCHERS: KeywordMatcher[] = [
  {
    name: "attractive-yields",
    test: (q) => q.includes("yield") || q.includes("apy"),
    run: answerAttractiveYields,
  },
  {
    name: "fastest-chains",
    test: (q) => q.includes("chain") && (q.includes("fast") || q.includes("grow")),
    run: answerFastestChains,
  },
  {
    name: "protocol-liquidity",
    test: (q) => q.includes("liquidity") || (q.includes("protocol") && (q.includes("gain") || q.includes("grow"))),
    run: answerProtocolLiquidity,
  },
  {
    name: "capital-flow",
    test: (q) => q.includes("capital") || q.includes("flow"),
    run: answerCapitalFlow,
  },
  {
    name: "weekly-digest",
    test: (q) => q.includes("week") || q.includes("digest") || q.includes("changed") || q.includes("summary"),
    run: answerWeeklyDigest,
  },
];

export async function runResearchQuery(rawQuery: string): Promise<ResearchResult | null> {
  const query = rawQuery.trim();
  if (!query) return null;
  const q = query.toLowerCase();

  const entity = await findEntityMention(q);
  if (entity?.type === "chain") return answerChainTrend(query, entity.chain);
  if (entity?.type === "protocol") return answerProtocolTrend(query, entity.protocol);

  for (const matcher of KEYWORD_MATCHERS) {
    if (matcher.test(q)) return matcher.run(query);
  }

  return null;
}
