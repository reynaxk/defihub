import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { chains, historicalObservations, pools, protocols } from "@/lib/database/schema";
import { getDailyVolumeHistory, getLatestVolumeObservation, getSwapEventCount, type DailyVolumePoint, type LatestVolumeObservation } from "@/lib/onchain/volume/queries";
import { getPoolObservationCount, getPoolTvlHistory, getVerifiedPools, type PoolTvlObservation } from "./pools";

// Phase 5.12, Part 7 - the "clean reusable internal contract" the phase
// asks for: every native metric this app can currently produce (TVL,
// volume, fees) is normalized into this ONE shape before it reaches an API
// route or a server component, so the UI never has to know which
// historical_observations metric/table a figure actually came from - only
// how to render {value, source, confidence, isPartial, observedAt,
// blockNumber, blockHash}. Reuses lib/onchain/volume/queries.ts's
// getDailyVolumeHistory/getLatestVolumeObservation and this file's own
// sibling pools.ts (getPoolTvlHistory/getVerifiedPools/getPoolObservationCount)
// verbatim - this file is a normalization layer over already-correct reads,
// not a new data path.
export type NativeMetricSource = "NATIVE" | "HYBRID" | "EXTERNAL" | "UNAVAILABLE";

export interface NativeMetric<T> {
  value: T | null;
  source: NativeMetricSource;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  // True whenever the underlying observation is real but knowingly
  // incomplete (e.g. a volume day where some swaps couldn't be priced) -
  // NEVER true merely because value is null/UNAVAILABLE, which is a
  // different, simpler case ("no data" vs. "some data, but not all of it").
  isPartial: boolean;
  observedAt: Date | null;
  blockNumber: number | null;
  blockHash: string | null;
}

function unavailableMetric<T>(): NativeMetric<T> {
  return { value: null, source: "UNAVAILABLE", confidence: null, isPartial: false, observedAt: null, blockNumber: null, blockHash: null };
}

// historicalObservations.priceLabel ("ONCHAIN_NATIVE"|"EXTERNAL_FALLBACK"|
// "HYBRID"|null) -> this contract's own NativeMetricSource vocabulary. Null
// covers both "predates Phase 5.12's priceLabel backfill" and "this write
// path never set it" - genuinely ambiguous provenance is UNAVAILABLE, never
// guessed as NATIVE (Section 6/16's "never silently blend/mislabel").
function sourceFromPriceLabel(priceLabel: string | null): NativeMetricSource {
  if (priceLabel === "ONCHAIN_NATIVE") return "NATIVE";
  if (priceLabel === "HYBRID") return "HYBRID";
  if (priceLabel === "EXTERNAL_FALLBACK") return "EXTERNAL";
  return "UNAVAILABLE";
}

export interface NativePoolIdentity {
  poolId: string;
  configKey: string;
  label: string;
  address: string;
  chainSlug: string;
  chainName: string;
  chainLogoUrl: string | null;
  explorerUrl: string | null;
  protocolSlug: string | null;
  protocolName: string | null;
}

// One pool, resolved by its public (chainSlug, address) route params - the
// same join shape getVerifiedPools (pools.ts) already establishes, just
// scoped to a single pool and including explorerUrl for the detail page's
// own address link (the same field OnchainVerificationCard's existing
// protocol-page usage already reads via a separate query).
//
// Case-insensitive on purpose (`lower(pools.address) = lower($1)`, not a
// plain `eq`) - live-verified this phase: pools.address is NOT uniformly
// lowercased across every existing row. register.ts's CURRENT code does
// lowercase it before insert, but a real row from an earlier point in this
// app's history (`0xACb70093...`, discovered pre-Phase-5.12) still has its
// original mixed-case form - a pre-existing data-quality fact this query
// must tolerate, not a Phase 5.12 regression to fix by rewriting history.
// The `pools` table is small (~200 rows) and this is a single-row lookup
// keyed first by the already-indexed chainId join, so the lack of a
// case-folded index here is not a real cost at this scale.
export async function getNativePoolIdentity(chainSlug: string, address: string): Promise<NativePoolIdentity | null> {
  const [row] = await db
    .select({
      poolId: pools.id,
      configKey: pools.configKey,
      label: pools.label,
      address: pools.address,
      chainSlug: chains.slug,
      chainName: chains.name,
      chainLogoUrl: chains.logoUrl,
      explorerUrl: chains.explorerUrl,
      protocolSlug: protocols.slug,
      protocolName: protocols.name,
    })
    .from(pools)
    .innerJoin(chains, eq(chains.id, pools.chainId))
    .leftJoin(protocols, eq(protocols.id, pools.protocolId))
    .where(and(eq(chains.slug, chainSlug), sql`lower(${pools.address}) = ${address.toLowerCase()}`));

  return row ?? null;
}

export interface NativePoolOverview {
  identity: NativePoolIdentity;
  tvl: NativeMetric<number>;
  volume: NativeMetric<number>;
  fees: NativeMetric<number>;
  swapCount: number;
  observationCount: number;
  earliestObservedAt: Date | null;
}

// A defensive fallback ONLY: pre-Phase-5.12 rows have no real priceLabel
// (every one is NULL - see record-verification.ts's own comment), so this
// derives an equivalent classification from the free-text priceSource
// string those rows DO have, purely for display continuity on old data.
// Every row written from this phase forward carries a real priceLabel and
// never needs this - tvlObservationToMetric below prefers the real column
// directly wherever it's available.
function sourceLabelFromPriceSourceString(priceSource: string | null): "ONCHAIN_NATIVE" | "EXTERNAL_FALLBACK" | "HYBRID" | null {
  if (priceSource === "onchain-pricing-engine") return "ONCHAIN_NATIVE";
  if (priceSource?.startsWith("hybrid:")) return "HYBRID";
  if (priceSource) return "EXTERNAL_FALLBACK";
  return null;
}

function tvlObservationToMetric(row: PoolTvlObservation | undefined): NativeMetric<number> {
  if (!row) return unavailableMetric();
  return {
    value: Number(row.value),
    source: sourceFromPriceLabel(row.priceLabel ?? sourceLabelFromPriceSourceString(row.priceSource)),
    confidence: null, // TVL has no volume-style per-swap confidence concept - see this module's own header comment
    isPartial: false,
    observedAt: row.timestamp,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
  };
}

export async function getNativePoolOverview(chainSlug: string, address: string): Promise<NativePoolOverview | null> {
  const identity = await getNativePoolIdentity(chainSlug, address);
  if (!identity) return null;

  const [tvlHistory, latestVolume, latestFees, observationCount, swapCount] = await Promise.all([
    getPoolTvlHistory(identity.poolId, null, 1),
    getLatestVolumeObservation(identity.poolId, "volume_usd"),
    getLatestVolumeObservation(identity.poolId, "fees_usd"),
    getPoolObservationCount(identity.poolId),
    getSwapEventCount(identity.poolId),
  ]);

  return {
    identity,
    tvl: tvlObservationToMetric(tvlHistory[tvlHistory.length - 1]),
    volume: volumeObservationToMetric(latestVolume),
    fees: volumeObservationToMetric(latestFees),
    swapCount,
    observationCount: observationCount.count,
    earliestObservedAt: observationCount.earliestAt,
  };
}

// The volume/fees twin of tvlObservationToMetric above. Unlike TVL, a
// volume_usd/fees_usd row's own `confidence`/`blockHash` are real and
// always present (recordVolumeObservation, record-volume-observation.ts,
// sets both on every write) - a prior version of this function discarded
// them and hardcoded confidence/blockHash to null, silently downgrading a
// NativeMetric that had real provenance available into one that looked
// unprovenanced. `source` is always "NATIVE": the volume engine's own
// toSwapTokenPrice (engine.ts) never falls back to an external price mid-
// calculation - see that function's own comment - so a volume_usd/fees_usd
// row is never HYBRID/EXTERNAL the way a tvl_usd row can be. `isPartial`
// mirrors the same "not fully priced" signal getDailyVolumeHistory's own
// isPartial already encodes at the daily-aggregate level, applied to this
// single latest observation: MEDIUM/LOW confidence means this specific run
// didn't get every swap priced.
function volumeObservationToMetric(row: LatestVolumeObservation | null): NativeMetric<number> {
  if (!row) return unavailableMetric();
  return {
    value: Number(row.value),
    source: "NATIVE",
    confidence: row.confidence,
    isPartial: row.confidence === "LOW" || row.confidence === "MEDIUM",
    observedAt: row.timestamp,
    blockNumber: row.blockNumber != null ? Number(row.blockNumber) : null,
    blockHash: row.blockHash,
  };
}

export interface NativeDailyPoint {
  day: Date;
  value: number;
  isPartial: boolean;
  excludedObservationCount: number;
  excludedSwapCount: number;
}

// Thin normalization over getDailyVolumeHistory - preserves its exact
// HIGH+MEDIUM-authoritative / LOW-excluded / isPartial semantics
// unchanged (Part 1's own explicit "preserve those semantics exactly"),
// never re-derives them.
function toNativeDailyPoints(points: DailyVolumePoint[]): NativeDailyPoint[] {
  return points.map((p) => ({ day: p.day, value: Number(p.volumeUsd), isPartial: p.isPartial, excludedObservationCount: p.excludedObservationCount, excludedSwapCount: p.excludedSwapCount }));
}

export async function getNativePoolVolumeHistory(poolId: string): Promise<NativeDailyPoint[]> {
  return toNativeDailyPoints(await getDailyVolumeHistory(poolId, "volume_usd"));
}

export async function getNativePoolFeesHistory(poolId: string): Promise<NativeDailyPoint[]> {
  return toNativeDailyPoints(await getDailyVolumeHistory(poolId, "fees_usd"));
}

export interface NativeTvlPoint {
  timestamp: Date;
  value: number;
  blockNumber: number | null;
  blockHash: string | null;
}

// getPoolTvlHistory already excludes reorg-invalidated rows and never
// recalculates from today's prices (each row IS the value at its own
// observation time/block) - this only reshapes it into the same
// {timestamp, value, ...} vocabulary the volume/fees history above uses,
// so a chart component can treat all three metrics uniformly.
export async function getNativePoolTvlHistory(poolId: string, since: Date | null): Promise<NativeTvlPoint[]> {
  const rows = await getPoolTvlHistory(poolId, since);
  return rows.map((r) => ({ timestamp: r.timestamp, value: Number(r.value), blockNumber: r.blockNumber, blockHash: r.blockHash }));
}

// ---------------------------------------------------------------------------
// Part 5 - native aggregation. Deliberately named/typed so nothing here can
// be mistaken for "DeFiHub's total DeFi coverage" - every field is a
// "-Native" or "-covered" name, and getNativeCoverageSummary's own return
// type has no field that could be confused with the DefiLlama-sourced
// protocolMetrics/chainMetrics totals used elsewhere in this app.
// ---------------------------------------------------------------------------

// CodeRabbit/manual review round: an earlier version of this summary
// summed EVERY pool's tvl_usd value into one `totalNativeTvlUsd`
// regardless of that pool's own tvlSource - so a HYBRID-priced pool (part
// native, part CoinGecko) or even a fully EXTERNAL_FALLBACK one silently
// inflated a total the page presented as "computed directly by DeFiHub's
// own on-chain reads, not DefiLlama or CoinGecko." That was the exact
// mislabeling this whole phase's provenance work exists to prevent -
// TVL's three real price states (NATIVE/HYBRID/EXTERNAL_FALLBACK) now stay
// three separate totals/counts, never pre-summed into one number a caller
// could present as pure. Volume/fees have no such split: the volume
// engine's own toSwapTokenPrice (lib/onchain/volume/engine.ts) never falls
// back to an external price mid-calculation, so every volume_usd/fees_usd
// observation that exists at all is unconditionally NATIVE - see
// volumeObservationToMetric's own comment above for the same fact applied
// to a single pool's latest observation.
export interface NativeCoverageSummary {
  totalNativeTvlUsd: number; // NATIVE-priced pools only
  totalHybridTvlUsd: number; // HYBRID-priced pools only - real DeFiHub balance reads, but at least one token's price came from CoinGecko
  totalExternalTvlUsd: number; // EXTERNAL_FALLBACK-priced pools only - a real on-chain balance read, priced entirely externally
  nativeTvlPoolCount: number;
  hybridTvlPoolCount: number;
  externalTvlPoolCount: number;
  totalNativeVolumeUsd24hEquivalent: number; // sum of each pool's OWN latest volume_usd observation - always fully native, see this function's own comment
  totalNativeFeesUsd24hEquivalent: number;
  indexedPoolCount: number; // pools with >=1 volume_usd/fees_usd observation
  pools: NativelyTrackedPoolSummary[];
}

export interface NativelyTrackedPoolSummary {
  poolId: string;
  configKey: string;
  label: string;
  address: string;
  chainSlug: string;
  chainName: string;
  protocolName: string | null;
  tvlUsd: number | null;
  tvlSource: NativeMetricSource;
  latestVolumeUsd: number | null;
  latestFeesUsd: number | null;
}

interface LatestMetricRow extends Record<string, unknown> {
  entityId: string;
  metric: string;
  value: string;
  priceLabel: string | null;
  priceSource: string | null;
}

// ONE query for "the latest canonical (reorg-uninvalidated) tvl_usd/
// volume_usd/fees_usd observation per pool," covering every pool at once -
// not a per-pool round trip. `DISTINCT ON` is Postgres's standard
// "latest row per group" idiom (the same job getVerifiedPools' own
// LATERAL join in a different file does for token prices) - this project's
// db client runs with `max: 1` connection outside production (see
// lib/database/client.ts's own comment on why), which makes even a
// moderate N+1 fan-out (3 queries x every pool this app tracks) something
// that could genuinely serialize behind one connection or exhaust the
// pool, not just a style preference.
async function getLatestPoolMetrics(): Promise<Map<string, LatestMetricRow[]>> {
  const rows = await db.execute<LatestMetricRow>(sql`
    select distinct on (entity_id, metric)
      entity_id as "entityId", metric, value, price_label as "priceLabel", price_source as "priceSource"
    from ${historicalObservations}
    where entity_type = 'pool'
      and metric in ('tvl_usd', 'volume_usd', 'fees_usd')
      and reorg_invalidated_at is null
    order by entity_id, metric, timestamp desc
  `);

  const byPoolId = new Map<string, LatestMetricRow[]>();
  for (const row of rows) {
    const list = byPoolId.get(row.entityId) ?? [];
    list.push(row);
    byPoolId.set(row.entityId, list);
  }
  return byPoolId;
}

// Reuses getVerifiedPools (pools.ts) UNCHANGED - that function was already
// generic over every `pools` row (curated AND discovered, see its own
// module comment) via a plain join against onchainVerifications, never
// filtered to VERIFIED_POOLS config specifically. This is the Part 5
// "thin aggregation layer": one pass over every pool that has ANY latest
// TVL/volume/fees observation, summed - two total queries (identities +
// latest-metrics), never one per pool.
export async function getNativeCoverageSummary(): Promise<NativeCoverageSummary> {
  const [verifiedPools, latestMetricsByPoolId] = await Promise.all([getVerifiedPools(), getLatestPoolMetrics()]);

  const perPool = verifiedPools.map((p) => {
    const metrics = latestMetricsByPoolId.get(p.id) ?? [];
    const tvlRow = metrics.find((m) => m.metric === "tvl_usd");
    const volumeRow = metrics.find((m) => m.metric === "volume_usd");
    const feesRow = metrics.find((m) => m.metric === "fees_usd");

    return {
      poolId: p.id,
      configKey: p.configKey,
      label: p.label,
      address: p.address,
      chainSlug: p.chainSlug,
      chainName: p.chainName,
      protocolName: p.protocolName,
      tvlUsd: tvlRow ? Number(tvlRow.value) : null,
      tvlSource: tvlRow ? sourceFromPriceLabel(tvlRow.priceLabel ?? sourceLabelFromPriceSourceString(tvlRow.priceSource)) : ("UNAVAILABLE" as const),
      latestVolumeUsd: volumeRow ? Number(volumeRow.value) : null,
      latestFeesUsd: feesRow ? Number(feesRow.value) : null,
    };
  });

  const nativeTvlPools = perPool.filter((p) => p.tvlUsd != null && p.tvlSource === "NATIVE");
  const hybridTvlPools = perPool.filter((p) => p.tvlUsd != null && p.tvlSource === "HYBRID");
  const externalTvlPools = perPool.filter((p) => p.tvlUsd != null && p.tvlSource === "EXTERNAL");
  const indexedPools = perPool.filter((p) => p.latestVolumeUsd != null);

  return {
    totalNativeTvlUsd: nativeTvlPools.reduce((sum, p) => sum + (p.tvlUsd ?? 0), 0),
    totalHybridTvlUsd: hybridTvlPools.reduce((sum, p) => sum + (p.tvlUsd ?? 0), 0),
    totalExternalTvlUsd: externalTvlPools.reduce((sum, p) => sum + (p.tvlUsd ?? 0), 0),
    nativeTvlPoolCount: nativeTvlPools.length,
    hybridTvlPoolCount: hybridTvlPools.length,
    externalTvlPoolCount: externalTvlPools.length,
    totalNativeVolumeUsd24hEquivalent: indexedPools.reduce((sum, p) => sum + (p.latestVolumeUsd ?? 0), 0),
    totalNativeFeesUsd24hEquivalent: indexedPools.reduce((sum, p) => sum + (p.latestFeesUsd ?? 0), 0),
    indexedPoolCount: indexedPools.length,
    pools: perPool,
  };
}
