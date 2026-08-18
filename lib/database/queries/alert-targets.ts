import { and, eq, ilike, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, protocols, tokens, yieldPools } from "@/lib/database/schema";

const RESULTS_LIMIT = 8;

export interface AlertTargetOption {
  value: string; // what actually gets stored as alerts.target
  label: string;
  meta: string | null;
}

// Each alert type stores a different identifier as `target` (see
// workers/alerts/check.ts's readProtocolTvl/readChainTvl/readTokenPrice/
// readPoolApy) - this picker has to search on the *display* name but return
// the exact identifier the checker actually reads, or a "selected" alert
// would silently never match anything.

export async function searchProtocolTargets(query: string): Promise<AlertTargetOption[]> {
  if (query.trim().length < 2) return [];
  const rows = await db
    .select({ name: protocols.name, slug: protocols.slug, category: protocols.category })
    .from(protocols)
    .where(ilike(protocols.name, `%${query}%`))
    .orderBy(protocols.name)
    .limit(RESULTS_LIMIT);
  return rows.map((r) => ({ value: r.slug, label: r.name, meta: r.category }));
}

export async function searchChainTargets(query: string): Promise<AlertTargetOption[]> {
  if (query.trim().length < 1) return [];
  const rows = await db
    .select({ name: chains.name, slug: chains.slug, nativeToken: chains.nativeToken })
    .from(chains)
    .where(ilike(chains.name, `%${query}%`))
    .orderBy(chains.name)
    .limit(RESULTS_LIMIT);
  return rows.map((r) => ({ value: r.slug, label: r.name, meta: r.nativeToken }));
}

// A token's coingeckoId (the alert target) is shared across every chain
// it's deployed on - dedupe to one row per id, or the same token would show
// once per chain deployment with identical behavior either way.
export async function searchTokenTargets(query: string): Promise<AlertTargetOption[]> {
  if (query.trim().length < 1) return [];
  const rows = await db
    .selectDistinctOn([tokens.coingeckoId], {
      coingeckoId: tokens.coingeckoId,
      symbol: tokens.symbol,
      name: tokens.name,
    })
    .from(tokens)
    .where(
      and(
        isNotNull(tokens.coingeckoId),
        or(ilike(tokens.symbol, `%${query}%`), ilike(tokens.name, `%${query}%`)),
      ),
    )
    .orderBy(tokens.coingeckoId, tokens.symbol)
    .limit(RESULTS_LIMIT);
  return rows.map((r) => ({ value: r.coingeckoId!, label: r.symbol, meta: r.name }));
}

export async function searchPoolTargets(query: string): Promise<AlertTargetOption[]> {
  if (query.trim().length < 2) return [];
  const rows = await db
    .select({
      externalPoolId: yieldPools.externalPoolId,
      symbol: yieldPools.symbol,
      protocolName: protocols.name,
      chainName: chains.name,
    })
    .from(yieldPools)
    .innerJoin(chains, eq(chains.id, yieldPools.chainId))
    .leftJoin(protocols, eq(protocols.id, yieldPools.protocolId))
    .where(ilike(yieldPools.symbol, `%${query}%`))
    .orderBy(yieldPools.symbol)
    .limit(RESULTS_LIMIT);
  return rows.map((r) => ({
    value: r.externalPoolId,
    label: r.symbol,
    meta: [r.protocolName, r.chainName].filter(Boolean).join(" · "),
  }));
}
