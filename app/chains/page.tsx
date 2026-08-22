import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { ChainsTable } from "@/components/chains/chains-table";
import { ChainComparisonChart } from "@/components/chains/chain-comparison";
import { ExportCsvButton } from "@/components/shared/export-csv-button";
import { getChainHistory, getChainProtocolCounts, getChainSparklines, getTopChains } from "@/lib/database/queries/chains";
import { getWatchedChainIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";

// Matches RangedAreaChart's default 30d range plus its own lookback margin
// (see the identical constant in queries/chains.ts) - the comparison charts
// default to 30d too, so this covers that render without a fetch.
const COMPARISON_HISTORY_DAYS = 35;
// A representative, well-known spread across L1s and L2s - not a ranking
// claim. Falls back gracefully (fewer tiles, or the section omitted
// entirely) if any of these ever isn't tracked, rather than guessing at a
// replacement.
const COMPARISON_CHAIN_SLUGS = ["ethereum", "solana", "arbitrum", "base"];
const COMPARISON_CACHE_REVALIDATE_SECONDS = 300;

// This page calls auth() and reads searchParams, which makes the whole
// route dynamic in Next.js 16 - `export const revalidate` below has no
// effect on it, so without this, the comparison charts' history queries
// (public, session-independent data) would re-run on every single request.
// unstable_cache keys on its arguments, so `since` is bucketed to the same
// revalidate window instead of a fresh Date.now() every call - otherwise
// every request would compute an ever-so-slightly newer cutoff and never
// hit the cache at all. `next/cache`'s cache scope also can't see
// headers/cookies (per its own docs) - this only takes chain ids + a
// bucketed timestamp as arguments, no auth/session data.
function comparisonSinceBucketed(days: number): Date {
  const bucketMs = COMPARISON_CACHE_REVALIDATE_SECONDS * 1000;
  const bucketedNow = Math.floor(Date.now() / bucketMs) * bucketMs;
  return new Date(bucketedNow - days * 24 * 60 * 60 * 1000);
}

const getCachedComparisonHistories = unstable_cache(
  async (chainIds: string[], sinceMs: number) => Promise.all(chainIds.map((id) => getChainHistory(id, new Date(sinceMs)))),
  ["chain-comparison-histories"],
  { revalidate: COMPARISON_CACHE_REVALIDATE_SECONDS },
);

export const metadata: Metadata = {
  title: "Chains",
  description: "Compare total value locked across supported blockchains.",
};

export const revalidate = 300;

const VALID_SORTS = ["tvl", "change24h", "change7d"] as const;
type ChainSort = (typeof VALID_SORTS)[number];

const SORT_ACCESSORS: Record<ChainSort, (c: { tvl: number | null; change24h: number | null; change7d: number | null }) => number | null> = {
  tvl: (c) => c.tvl,
  change24h: (c) => c.change24h,
  change7d: (c) => c.change7d,
};

export default async function ChainsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const sortBy = (VALID_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as ChainSort)
    : "tvl";
  const sortDir = params.dir === "asc" ? "asc" : "desc";

  const [session, chains] = await Promise.all([auth(), getTopChains()]);

  // getTopChains already ranks by TVL desc - only re-sort when a different
  // sort is actually requested, so the default (no query params) path
  // matches its existing, already-correct ordering exactly.
  const sorted =
    sortBy === "tvl" && sortDir === "desc"
      ? chains
      : [...chains].sort((a, b) => {
          const av = SORT_ACCESSORS[sortBy](a);
          const bv = SORT_ACCESSORS[sortBy](b);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return sortDir === "asc" ? av - bv : bv - av;
        });

  const [watchedChainIds, protocolCounts, sparklines] = await Promise.all([
    getWatchedChainIds(session?.user?.id, chains.map((c) => c.id)),
    getChainProtocolCounts(chains.map((c) => c.id)),
    getChainSparklines(chains.map((c) => c.id)),
  ]);

  const comparisonChains = COMPARISON_CHAIN_SLUGS.map((slug) => chains.find((c) => c.slug === slug)).filter(
    (c): c is (typeof chains)[number] => c != null,
  );
  const comparisonSince = comparisonSinceBucketed(COMPARISON_HISTORY_DAYS);
  const comparisonHistories = await getCachedComparisonHistories(
    comparisonChains.map((c) => c.id),
    comparisonSince.getTime(),
  );
  const comparisonEntries = comparisonChains.map((c, i) => ({
    slug: c.slug,
    name: c.name,
    logoUrl: c.logoUrl,
    tvl: c.tvl,
    change24h: c.change24h,
    history: comparisonHistories[i].map((h) => ({ timestamp: h.timestamp.toISOString(), value: h.tvl })),
  }));

  function buildSortHref(sortKey: string, dir: "asc" | "desc") {
    const query = new URLSearchParams();
    if (sortKey !== "tvl") query.set("sort", sortKey);
    if (dir === "asc") query.set("dir", dir);
    const qs = query.toString();
    return qs ? `/chains?${qs}` : "/chains";
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/60 pb-6">
        <div>
          <p className="text-xs font-medium tracking-[0.15em] text-muted-foreground uppercase">DeFi Markets</p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">Chains</h1>
          <p className="mt-1 text-sm text-muted-foreground">{chains.length} chains tracked</p>
        </div>
        <ExportCsvButton endpoint="/api/export/chains" />
      </div>

      {comparisonEntries.length >= 2 && (
        <div className="mt-6">
          <h2 className="mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Chain comparison
          </h2>
          <ChainComparisonChart chains={comparisonEntries} />
        </div>
      )}

      <div className="mt-8">
        <ChainsTable
          chains={sorted}
          isSignedIn={Boolean(session?.user)}
          watchedChainIds={watchedChainIds}
          protocolCounts={protocolCounts}
          sparklines={sparklines}
          sort={{ key: sortBy, dir: sortDir, hrefFor: buildSortHref }}
        />
      </div>
    </div>
  );
}
