import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chainMetrics, chains, protocolMetrics, protocols } from "@/lib/database/schema";
import { computeTvlChanges } from "./tvl-change";

export interface ChainListItem {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  nativeToken: string;
  tvl: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
}

// computeTvlChanges' 30d window needs a real data point at least ~21 days
// back to resolve (its own 0.7 tolerance) - matches the identical constant
// and reasoning in getChainBySlug below.
const TOP_CHAINS_HISTORY_DAYS = 35;

export async function getTopChains(): Promise<ChainListItem[]> {
  const chainRows = await db.select().from(chains);

  // Bounded to the window computeTvlChanges actually needs, not every row
  // ever synced - this was the one query left fetching the entire
  // chain_metrics table unfiltered (every other history read in this
  // codebase pushes a `since` bound into SQL). chain_metrics is one of the
  // three explicitly unbounded, ever-growing time-series tables, and this
  // function backs the uncached public /api/v1/chains and /api/export/chains
  // routes in addition to the ISR-cached homepage/chains pages.
  const since = new Date(Date.now() - TOP_CHAINS_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const allMetrics = await db
    .select({ chainId: chainMetrics.chainId, timestamp: chainMetrics.timestamp, tvl: chainMetrics.tvl })
    .from(chainMetrics)
    .where(gte(chainMetrics.timestamp, since))
    .orderBy(chainMetrics.timestamp);

  const byChain = new Map<string, { timestamp: Date; tvl: number | null }[]>();
  for (const m of allMetrics) {
    const list = byChain.get(m.chainId) ?? [];
    list.push({ timestamp: m.timestamp, tvl: m.tvl != null ? Number(m.tvl) : null });
    byChain.set(m.chainId, list);
  }

  const items = chainRows.map((chain) => {
    const changes = computeTvlChanges(byChain.get(chain.id) ?? []);
    return {
      id: chain.id,
      name: chain.name,
      slug: chain.slug,
      logoUrl: chain.logoUrl,
      nativeToken: chain.nativeToken,
      tvl: changes.latest,
      change24h: changes.change24h,
      change7d: changes.change7d,
      change30d: changes.change30d,
    };
  });

  return items.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
}

// Compact recent-TVL series per chain, for the homepage's Market Pulse
// sparklines. A dedicated query rather than extending ChainListItem/
// getTopChains, which also backs the public /api/v1/chains and
// /api/export/chains contracts - those shouldn't gain a new field for a
// homepage-only visual.
const SPARKLINE_DAYS = 14;

export async function getChainSparklines(chainIds: string[]): Promise<Map<string, number[]>> {
  if (chainIds.length === 0) return new Map();
  const since = new Date(Date.now() - SPARKLINE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ chainId: chainMetrics.chainId, timestamp: chainMetrics.timestamp, tvl: chainMetrics.tvl })
    .from(chainMetrics)
    .where(and(inArray(chainMetrics.chainId, chainIds), gte(chainMetrics.timestamp, since)))
    .orderBy(chainMetrics.timestamp);

  const byChain = new Map<string, number[]>();
  for (const r of rows) {
    if (r.tvl == null) continue;
    const list = byChain.get(r.chainId) ?? [];
    list.push(Number(r.tvl));
    byChain.set(r.chainId, list);
  }
  return byChain;
}

export async function getGlobalTvlHistory(): Promise<{ timestamp: Date; tvl: number }[]> {
  // `date_trunc('day', ts)` on a timestamptz truncates using the Postgres
  // *session's* TimeZone setting, not UTC - nothing in this app pins that
  // (lib/database/client.ts opens the connection with no timezone option),
  // so which calendar day a given row lands in would silently depend on
  // wherever Postgres happens to be deployed/configured, and would reshape
  // differently across a DST transition even with no code change.
  // `AT TIME ZONE 'UTC'` converts to the UTC wall-clock value first, so the
  // truncation is deterministic regardless of session/server timezone. The
  // second `AT TIME ZONE 'UTC'` converts the (now timezone-less) truncated
  // value back to a real timestamptz - needed because postgres.js sends a
  // plain `timestamp without time zone` back over the wire as a bare
  // "YYYY-MM-DDTHH:mm:ss" string with no offset, which JS's `new Date()`
  // parses as *local* time, silently reintroducing the exact bug this is
  // fixing at a different layer.
  const dayTrunc = sql`(date_trunc('day', ${chainMetrics.timestamp} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  const rows = await db
    .select({
      day: sql<Date>`${dayTrunc}`.as("day"),
      tvl: sql<string>`sum(${chainMetrics.tvl})`.as("tvl"),
    })
    .from(chainMetrics)
    .groupBy(dayTrunc)
    .orderBy(dayTrunc);

  // `date_trunc` on a raw sql fragment comes back from the postgres driver
  // as a string, not a parsed Date, despite the sql<Date> type hint -
  // coerce explicitly rather than trusting that annotation at runtime.
  return rows.map((r) => ({ timestamp: new Date(r.day), tvl: Number(r.tvl) }));
}

// A single indexed id lookup, for callers (the history API route) that
// only need the id to run a bounded range query - avoids pulling a whole
// history window via getChainBySlug just to discover it.
export async function getChainIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db.select({ id: chains.id }).from(chains).where(eq(chains.slug, slug));
  return row?.id ?? null;
}

export interface ChainHistoryPoint {
  timestamp: Date;
  tvl: number | null;
}

// Pushes the requested range down into the query instead of fetching every
// row ever synced and filtering client-side - `since: null` means no lower
// bound (the chart's "all" range). Shared by getChainBySlug (bounded below)
// and the range-switching history API route
// (app/api/chains/[slug]/history).
export async function getChainHistory(chainId: string, since: Date | null): Promise<ChainHistoryPoint[]> {
  const conditions = [eq(chainMetrics.chainId, chainId)];
  if (since) conditions.push(gte(chainMetrics.timestamp, since));

  const rows = await db
    .select({ timestamp: chainMetrics.timestamp, tvl: chainMetrics.tvl })
    .from(chainMetrics)
    .where(and(...conditions))
    .orderBy(chainMetrics.timestamp);

  return rows.map((h) => ({ timestamp: h.timestamp, tvl: h.tvl != null ? Number(h.tvl) : null }));
}

// A few days more than RangedAreaChart's own 30-day default range (see the
// identical constant in queries/protocols.ts) - this history also feeds
// computeTvlChanges below, whose 30d window needs a real data point at
// least ~21 days back (its own 0.7 tolerance) to resolve. The extra margin
// keeps that safely inside the fetched window rather than exactly at its
// edge.
const DEFAULT_HISTORY_DAYS = 35;

export async function getChainBySlug(slug: string) {
  const [chain] = await db.select().from(chains).where(eq(chains.slug, slug));
  if (!chain) return null;

  const since = new Date(Date.now() - DEFAULT_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const history = await getChainHistory(chain.id, since);

  const latestTs = await db
    .select({ ts: sql<Date>`max(${protocolMetrics.timestamp})`.as("ts") })
    .from(protocolMetrics)
    .where(eq(protocolMetrics.chainId, chain.id));

  const topProtocols =
    latestTs[0]?.ts != null
      ? await db
          .select({
            id: protocols.id,
            name: protocols.name,
            slug: protocols.slug,
            logoUrl: protocols.logoUrl,
            category: protocols.category,
            tvl: protocolMetrics.tvl,
            // Fees/volume/revenue are only tracked in aggregate (all-chains)
            // rows, not broken down per chain - null here is accurate, not
            // a bug: we simply don't have that per-chain figure.
            volume24h: sql<string | null>`null`,
            fees24h: sql<string | null>`null`,
            revenue24h: sql<string | null>`null`,
            tvlChange1d: sql<string | null>`null`,
            tvlChange7d: sql<string | null>`null`,
          })
          .from(protocolMetrics)
          .innerJoin(protocols, eq(protocolMetrics.protocolId, protocols.id))
          .where(sql`${protocolMetrics.chainId} = ${chain.id} and ${protocolMetrics.timestamp} = ${latestTs[0].ts}`)
          .orderBy(desc(protocolMetrics.tvl))
          .limit(50)
      : [];

  return {
    chain,
    history,
    topProtocols: topProtocols.map((p) => ({
      ...p,
      tvl: p.tvl != null ? Number(p.tvl) : null,
      volume24h: null,
      fees24h: null,
      revenue24h: null,
      tvlChange1d: null,
      tvlChange7d: null,
    })),
    latestTvl: history.length > 0 ? history[history.length - 1].tvl : null,
    changes: computeTvlChanges(history),
  };
}

export async function getAllChains() {
  return db.select().from(chains).orderBy(chains.name);
}
