import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export const chains = pgTable("chains", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  chainId: integer("chain_id"), // EVM chain id; null for non-EVM chains (e.g. Solana)
  nativeToken: varchar("native_token", { length: 32 }).notNull(),
  logoUrl: text("logo_url"),
  explorerUrl: text("explorer_url"),
  defillamaSlug: varchar("defillama_slug", { length: 64 }).unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chainMetrics = pgTable(
  "chain_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    tvl: numeric("tvl", { precision: 24, scale: 2 }),
  },
  (table) => [
    index("chain_metrics_chain_ts_idx").on(table.chainId, table.timestamp),
    uniqueIndex("chain_metrics_unique_snapshot").on(table.chainId, table.timestamp),
  ],
);

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

export const protocols = pgTable(
  "protocols",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 128 }).notNull().unique(),
    description: text("description"),
    website: text("website"),
    logoUrl: text("logo_url"),
    category: varchar("category", { length: 64 }),
    // Maps this row to the upstream provider's identifier so sync jobs can
    // upsert deterministically without fuzzy name-matching.
    defillamaSlug: varchar("defillama_slug", { length: 128 }).unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("protocols_category_idx").on(table.category)],
);

export const protocolChains = pgTable(
  "protocol_chains",
  {
    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocols.id, { onDelete: "cascade" }),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    contractAddresses: jsonb("contract_addresses").$type<Record<string, string>>(),
  },
  (table) => [primaryKey({ columns: [table.protocolId, table.chainId] })],
);

export const protocolMetrics = pgTable(
  "protocol_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocols.id, { onDelete: "cascade" }),
    // null = aggregate across all chains the protocol is deployed on
    chainId: uuid("chain_id").references(() => chains.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    tvl: numeric("tvl", { precision: 24, scale: 2 }),
    volume24h: numeric("volume_24h", { precision: 24, scale: 2 }),
    fees24h: numeric("fees_24h", { precision: 24, scale: 2 }),
    revenue24h: numeric("revenue_24h", { precision: 24, scale: 2 }),
    // DefiLlama's own pre-computed TVL change, not derived from our
    // snapshot history - `protocol_metrics` only accumulates one row per
    // sync run, too sparse to compute a real 7d change from until this app
    // has been running for weeks. Chain-level changes (lib/database/queries
    // /tvl-change.ts) differ - chain history is fully backfilled, so those
    // are computed locally instead.
    // precision 10 (max ~1M%) turned out too narrow: a real sync against
    // DefiLlama's long tail of thin/new-pool protocols hit a genuine
    // numeric field overflow the first time a wider chain set (adding
    // Avalanche/Polygon/Optimism) pulled in a protocol with a more
    // extreme change_1d than anything seen on the original 5 chains.
    // Widened with real headroom rather than tuned to the one value that
    // broke it.
    tvlChange1d: numeric("tvl_change_1d", { precision: 18, scale: 4 }),
    tvlChange7d: numeric("tvl_change_7d", { precision: 18, scale: 4 }),
  },
  (table) => [
    index("protocol_metrics_protocol_ts_idx").on(table.protocolId, table.timestamp),
    // Every hot list page (home, /protocols x2 per request, /chain/[slug],
    // CSV export) filters/aggregates by chain_id (either `IS NULL` for the
    // cross-chain aggregate rows, or `= <chain>` for a specific chain's
    // rows) and takes MAX(timestamp) or ORDER BY timestamp within that
    // group - neither the protocol_id-leading index above nor the unique
    // snapshot index below can serve either without a full scan. Btree
    // indexes support `IS NULL` on a leading column same as an equality
    // match, so this one index covers both query shapes.
    index("protocol_metrics_chain_ts_idx").on(table.chainId, table.timestamp),
    // Postgres treats every NULL as distinct from every other NULL in a
    // unique index, so this composite index only actually enforces
    // uniqueness for per-chain rows (chainId non-null) - two aggregate rows
    // (chainId IS NULL) with the identical (protocolId, timestamp) are NOT
    // rejected as a conflict, so workers/protocols/sync.ts's
    // onConflictDoNothing() silently never engages for them. Confirmed
    // exploitable: DefiLlama's protocol list is known to list the same
    // protocol twice under a parent/child relationship, which would insert
    // as true, undetected duplicates within a single sync run - doubling
    // that protocol on the homepage/protocols list and inflating totals.
    // Kept alongside the composite index above (which still correctly
    // covers the per-chain case) rather than replacing it.
    uniqueIndex("protocol_metrics_unique_snapshot").on(
      table.protocolId,
      table.chainId,
      table.timestamp,
    ),
    uniqueIndex("protocol_metrics_unique_aggregate_snapshot")
      .on(table.protocolId, table.timestamp)
      .where(sql`${table.chainId} is null`),
  ],
);

// ---------------------------------------------------------------------------
// Tokens & prices
// ---------------------------------------------------------------------------

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    address: varchar("address", { length: 128 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    name: text("name"),
    // Nullable, no default - a token's decimals are either confirmed via an
    // on-chain decimals() read (workers/tokens/sync.ts) or genuinely
    // unknown. A NOT NULL DEFAULT 18 here previously meant every row silently
    // claimed 18 decimals whether or not that was ever verified (CoinGecko's
    // bulk markets endpoint, the only writer at the time, doesn't return
    // per-token decimals at all) - wrong for most 6/8-decimal tokens (e.g.
    // USDT/USDC). Consumers must treat null as "don't trust this for
    // raw-unit math," never substitute an assumed value.
    decimals: integer("decimals"),
    logoUrl: text("logo_url"),
    // Identifier used to query the CoinGecko price provider.
    coingeckoId: varchar("coingecko_id", { length: 128 }),
  },
  (table) => [
    uniqueIndex("tokens_chain_address_unique").on(table.chainId, table.address),
    // getTokenByAddress (app route + public API) filters by address alone,
    // optionally narrowed by chain after a join - the composite unique
    // index above has address as its second column, so it can't serve a
    // lookup that doesn't also pin chainId. Cheap at current scale (~400
    // rows) but a real gap as the token list grows.
    index("tokens_address_idx").on(table.address),
  ],
);

export const tokenPrices = pgTable(
  "token_prices",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    priceUsd: numeric("price_usd", { precision: 24, scale: 8 }).notNull(),
    marketCap: numeric("market_cap", { precision: 24, scale: 2 }),
    volume24h: numeric("volume_24h", { precision: 24, scale: 2 }),
    // Percent, as reported directly by the price provider (e.g. CoinGecko's
    // own trailing-24h computation) - not derived from our own snapshots,
    // which would need two sync runs a day apart to mean anything.
    priceChange24h: numeric("price_change_24h", { precision: 10, scale: 4 }),
    // Only populated by the token-discovery sync (every 6h, top 250 by
    // market cap), not the 15-minute price-refresh sync - CoinGecko's
    // /simple/price endpoint that sync uses has no 7d window, only
    // /coins/markets does. Most rows will have this null; queries reading
    // it look back to the most recent non-null value per token rather than
    // assuming the latest row has it (see getTopMovers).
    priceChange7d: numeric("price_change_7d", { precision: 10, scale: 4 }),
  },
  (table) => [primaryKey({ columns: [table.tokenId, table.timestamp] })],
);

// ---------------------------------------------------------------------------
// Yield pools
// ---------------------------------------------------------------------------

export const yieldPools = pgTable(
  "yield_pools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalPoolId: varchar("external_pool_id", { length: 128 }).notNull().unique(),
    protocolId: uuid("protocol_id").references(() => protocols.id, { onDelete: "set null" }),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    symbol: varchar("symbol", { length: 128 }).notNull(),
    underlyingTokens: jsonb("underlying_tokens").$type<string[]>(),
    apy: numeric("apy", { precision: 10, scale: 4 }),
    apyBase: numeric("apy_base", { precision: 10, scale: 4 }),
    apyReward: numeric("apy_reward", { precision: 10, scale: 4 }),
    tvlUsd: numeric("tvl_usd", { precision: 24, scale: 2 }),
    stablecoin: boolean("stablecoin").default(false).notNull(),
    ilRisk: varchar("il_risk", { length: 16 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("yield_pools_chain_idx").on(table.chainId),
    // Both indexes below go unused for a plain unfiltered sort+limit
    // (~13K rows is cheap enough that Postgres correctly prefers a
    // seq scan + top-N heapsort - confirmed via EXPLAIN ANALYZE, cost
    // is identical with or without the index). They earn their keep
    // on getYieldPoolsList's minApy/maxApy/minTvl filters, where the
    // planner switches to a Bitmap Index Scan and execution time drops
    // from ~13ms to ~4.4ms (confirmed via EXPLAIN ANALYZE on a
    // `tvl_usd >= 1000000 order by apy` style query, matching real
    // filter combinations the yields page supports).
    index("yield_pools_apy_idx").on(table.apy),
    index("yield_pools_tvl_idx").on(table.tvlUsd),
  ],
);

export const protocolAiSummaries = pgTable("protocol_ai_summaries", {
  protocolId: uuid("protocol_id")
    .primaryKey()
    .references(() => protocols.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  model: varchar("model", { length: 64 }).notNull(),
  // TVL at the moment this summary was generated - lets a later read detect
  // "this summary's scale/risk characterization no longer matches reality"
  // (e.g. a 50% TVL crash) and stop serving it, rather than caching forever
  // with no invalidation at all. See getCachedProtocolSummary.
  tvlAtGeneration: numeric("tvl_at_generation", { precision: 24, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// On-chain verification
//
// A small, deliberately bounded exception to "no direct RPC" (see
// docs/architecture.md): for a handful of hand-picked, well-understood
// on-chain reads (currently one Uniswap V3 pool's raw token balances), we
// read directly from a public Ethereum RPC and show the result as an
// independent cross-check next to the aggregator-sourced number. Each row is
// keyed by a stable slug (`lib/onchain/config.ts`), not auto-discovered.
// ---------------------------------------------------------------------------

export const onchainVerifications = pgTable("onchain_verifications", {
  key: varchar("key", { length: 64 }).primaryKey(),
  protocolId: uuid("protocol_id").references(() => protocols.id, { onDelete: "cascade" }),
  chainId: uuid("chain_id")
    .notNull()
    .references(() => chains.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  poolAddress: varchar("pool_address", { length: 128 }).notNull(),
  tvlUsd: numeric("tvl_usd", { precision: 24, scale: 2 }).notNull(),
  blockNumber: numeric("block_number", { precision: 20, scale: 0 }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Canonical on-chain entities (pools, pool tokens) - Phase 4
//
// Persists the same human-curated, research-verified entries already
// defined in lib/onchain/config.ts's VERIFIED_POOLS as real, queryable
// database rows, instead of only living as a TypeScript config array. The
// config file stays the source of truth an engineer edits and reviews (see
// its own module comment on why this app deliberately doesn't
// auto-discover pools, and requires a human to confirm every entry before
// it's added) - these tables are the derived, canonical representation
// that the rest of the app can query like any other entity.
// lib/onchain/pools.ts keeps them in sync with the config on every
// verification run (upsert by configKey, never auto-discovered here
// either).
// ---------------------------------------------------------------------------

export const pools = pgTable(
  "pools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Matches VERIFIED_POOLS' own `key` - the stable join back to the
    // curated config entry this row was derived from.
    configKey: varchar("config_key", { length: 64 }).notNull().unique(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    protocolId: uuid("protocol_id").references(() => protocols.id, { onDelete: "set null" }),
    label: text("label").notNull(),
    address: varchar("address", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("pools_chain_address_unique").on(table.chainId, table.address)],
);

export const poolTokens = pgTable(
  "pool_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    address: varchar("address", { length: 128 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    // Never defaulted (see lib/chains/token-decimals.ts's own comment on
    // why 18 is never a safe assumption) - a pool token whose decimals
    // couldn't be confirmed stays null rather than guessed.
    decimals: integer("decimals"),
    coingeckoId: varchar("coingecko_id", { length: 128 }),
    // Preserves VERIFIED_POOLS' own token ordering (position in the
    // array) - not semantically meaningful beyond display order.
    position: integer("position").notNull(),
  },
  (table) => [uniqueIndex("pool_tokens_pool_position_unique").on(table.poolId, table.position)],
);

// ---------------------------------------------------------------------------
// Historical observations - Phase 4
//
// A generic, append-only time series for DeFiHub-native calculated metrics
// (currently: on-chain-verified pool TVL) - deliberately not specific to
// pools, so a future native metric (another AMM adapter, a native price
// source, ...) writes into this same table rather than each needing its
// own history table. `onchain_verifications` above stays as the fast
// "latest value" lookup the existing UI already reads (a single upserted
// row per key, no history) - this table is the durable history that was
// previously discarded on every overwrite.
//
// entityType/entityId is a deliberately simple pairing rather than a
// polymorphic FK - Postgres has no clean native way to FK a column against
// "whichever table entityType names," and a nullable FK column per
// possible entity type doesn't scale as more entity types are added.
// Consumers join back to the real table themselves using entityType to
// pick which one (currently only "pool", referencing pools.id).
// ---------------------------------------------------------------------------

// The per-token snapshot an on-chain calculation actually used - enough to
// mechanically redo the same calculation later (e.g. computePoolTvl) and
// confirm it reproduces `value`, without needing anything not already
// captured at calculation time. Never populated with placeholder/derived
// values for a token whose real balance or price wasn't actually read.
export interface HistoricalObservationCalculationInput {
  symbol: string;
  coingeckoId: string;
  decimals: number;
  balanceRaw: string; // exact on-chain integer balance, as a string (too large for a JS number in general)
  // The exact decimal string the calculation actually used, not a
  // `number` - a JS number can't losslessly hold every real decimal price
  // (e.g. 0.1 isn't exactly representable in binary floating point), so
  // storing this as `number` would round the "input" half of the
  // provenance record even where the calculation itself stayed exact.
  priceUsd: string;
}

export const historicalObservations = pgTable(
  "historical_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainId: uuid("chain_id").references(() => chains.id, { onDelete: "cascade" }),
    // e.g. "pool" - which table entityId's value refers to.
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    // e.g. "tvl_usd" - which figure this row is a snapshot of, so the same
    // entity can eventually have more than one tracked native metric
    // without a new table.
    metric: varchar("metric", { length: 32 }).notNull(),
    value: numeric("value", { precision: 32, scale: 8 }).notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    blockNumber: numeric("block_number", { precision: 20, scale: 0 }),
    // The pinned block's own hash, not just its number - a block number
    // alone doesn't identify *which* chain history it belonged to if that
    // height was later reorged onto a different canonical block. Null for
    // any observation whose source never had a block to pin (or predates
    // this column) - never backfilled or guessed.
    blockHash: varchar("block_hash", { length: 128 }),
    // Which price provider produced the price(s) baked into `value`, and
    // when they were fetched - both null for an observation with no
    // external price input (or that predates this column). Together with
    // calculationInputs below, this is what makes a native calculation
    // replayable: the exact inputs, and where/when they came from.
    priceSource: varchar("price_source", { length: 64 }),
    priceRetrievedAt: timestamp("price_retrieved_at", { withTimezone: true }),
    calculationInputs: jsonb("calculation_inputs").$type<HistoricalObservationCalculationInput[]>(),
    // e.g. "onchain-verification" - which subsystem computed this, for the
    // native-vs-external provenance distinction (never label externally-
    // sourced data as DeFiHub-native, or vice versa).
    source: varchar("source", { length: 64 }).notNull(),
    // Free-form, optional - lets a future change to how a metric is
    // computed (e.g. a new AMM adapter's math) be distinguished from
    // observations computed the old way, without needing to backfill or
    // silently mix incompatible historical figures.
    calculationVersion: varchar("calculation_version", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("historical_observations_entity_idx").on(table.entityType, table.entityId, table.metric, table.timestamp),
    // Block-level idempotency, not timestamp-level: `timestamp` is the
    // wall-clock moment a verification run happened to execute, which
    // differs on every retry even when the run reads the exact same chain
    // block - a (entityType, entityId, metric, timestamp) unique index
    // (this table's original dedup guard, removed by this migration)
    // therefore never actually caught a retried observation of the same
    // block, since that timestamp essentially never repeats. Identity here
    // is the block itself: same pool + same block number + same block hash
    // is one observation; same block number with a *different* hash is a
    // distinct, legitimate observation (a reorg moved that height onto
    // different chain history, and both are real data worth keeping).
    //
    // Two *partial* unique indexes, not one - scoped to `blockNumber IS
    // NOT NULL` so a row with no block at all (any current entityType/
    // metric other than "pool"/"tvl_usd", or a future one) is entirely
    // outside this rule and free to repeat, same as before. Split into two
    // rather than one to make blockHash's nullability explicitly null-safe
    // without relying on ordinary SQL NULL semantics (where two NULLs are
    // never "equal," so duplicate no-hash rows for the same block would
    // otherwise silently accumulate) - the "hash known" and "hash unknown"
    // cases are mutually exclusive by their own predicates, so exactly one
    // of the two ever applies to a given row, and either one is expressible
    // as a plain-column partial index (no COALESCE expression needed),
    // which keeps the insert's ON CONFLICT target fully typed - see
    // recordPoolVerification in verify-pool.ts, which picks whichever of
    // the two applies based on whether it's inserting a known blockHash.
    uniqueIndex("historical_observations_block_hash_identity_unique")
      .on(table.entityType, table.entityId, table.metric, table.blockNumber, table.blockHash)
      .where(sql`${table.blockNumber} is not null and ${table.blockHash} is not null`),
    uniqueIndex("historical_observations_block_only_identity_unique")
      .on(table.entityType, table.entityId, table.metric, table.blockNumber)
      .where(sql`${table.blockNumber} is not null and ${table.blockHash} is null`),
    // A native pool TVL observation without a block hash isn't reliable
    // provenance - it can't be checked against a reorg later, and it's
    // exactly the "block number only" case the second index above exists
    // for, which this constraint now closes off specifically for
    // (entityType: "pool", metric: "tvl_usd") going forward. Scoped to
    // that one entityType/metric pair, not the whole table - a different,
    // future metric that legitimately has no block-level provenance stays
    // completely unconstrained by this rule (see column comments above).
    // Added `NOT VALID` (in the migration, not expressible here) rather
    // than fully validated: real historical rows already exist that
    // predate blockHash tracking (see blockHash's own column comment,
    // "or predates this column") - those are genuine data, not defects,
    // and this constraint must not force dropping or rewriting them to be
    // added. NOT VALID enforces the rule for every new insert/update from
    // this point forward without retroactively scanning/rejecting rows
    // that were always going to fail it. See recordPoolVerification in
    // verify-pool.ts, which now refuses to write a pool/tvl_usd
    // observation at all when blockHash is unavailable, rather than
    // relying on this constraint alone to catch it.
    check(
      "historical_observations_pool_tvl_requires_block_identity",
      sql`${table.entityType} <> 'pool' OR ${table.metric} <> 'tvl_usd' OR (${table.blockNumber} IS NOT NULL AND ${table.blockHash} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Auth.js (users / OAuth accounts / verification tokens)
// JWT session strategy is used (required by the Credentials provider), so no
// `sessions` table is needed.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    image: text("image"),
    // null for OAuth-only accounts
    passwordHash: text("password_hash"),
    // Stamped whenever passwordHash changes via the reset-password flow (null
    // for an account that's never reset its password). Embedded into the JWT
    // at sign-in and re-checked against this column on every request in
    // lib/auth/config.ts's jwt callback, so a password reset actually
    // invalidates sessions issued before it - otherwise a stateless JWT
    // (required for the Credentials provider) would stay valid for its full
    // maxAge regardless of a reset, which defeats the point of resetting a
    // password you suspect is compromised.
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Added NOT VALID by migration 0019 (existing rows aren't re-checked -
    // migration 0017's lowercasing deliberately skips unresolved
    // case-insensitive collision groups rather than auto-merging them, so
    // some legacy rows may not satisfy this yet), but enforced for every
    // new INSERT/UPDATE from that migration forward. Registration/login/
    // forgot-password already normalize email to lowercase before it
    // reaches the DB (lib/auth/config.ts, app/api/auth/register,
    // app/api/auth/forgot-password) - this is the backstop that makes that
    // an actual guarantee rather than just an application-level convention.
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"oauth" | "oidc" | "email" | "webauthn">().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    // These JS property names must stay snake_case (not camelCase) - the
    // Auth.js DrizzleAdapter accesses them by these exact keys.
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

export const verificationTokens = pgTable(
  "verification_token",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

// ---------------------------------------------------------------------------
// Watchlist & Alerts
// ---------------------------------------------------------------------------

export const watchlist = pgTable(
  "watchlist",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    protocolId: uuid("protocol_id").references(() => protocols.id, { onDelete: "cascade" }),
    chainId: uuid("chain_id").references(() => chains.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }),
    yieldPoolId: uuid("yield_pool_id").references(() => yieldPools.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("watchlist_user_protocol_unique").on(table.userId, table.protocolId),
    uniqueIndex("watchlist_user_chain_unique").on(table.userId, table.chainId),
    uniqueIndex("watchlist_user_token_unique").on(table.userId, table.tokenId),
    uniqueIndex("watchlist_user_yield_pool_unique").on(table.userId, table.yieldPoolId),
  ],
);

export const alertTypeEnum = pgEnum("alert_type", [
  "protocol_tvl",
  "chain_tvl",
  "token_price",
  "pool_apy",
]);

export const alertConditionEnum = pgEnum("alert_condition", [
  "above",
  "below",
  "percent_change_up",
  "percent_change_down",
]);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: alertTypeEnum("type").notNull(),
    // slug/address/id of the protocol|chain|token|pool being watched
    target: text("target").notNull(),
    condition: alertConditionEnum("condition").notNull(),
    threshold: numeric("threshold", { precision: 24, scale: 8 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // Whether the condition evaluated true as of the most recent check -
    // updated every run regardless of outcome, distinct from
    // lastTriggeredAt (only updated when we actually emailed). Lets the
    // worker email only on a false->true transition instead of every 10
    // minutes the condition happens to still hold (see workers/alerts/check.ts).
    isFiring: boolean("is_firing").default(false).notNull(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("alerts_user_idx").on(table.userId),
    index("alerts_enabled_idx").on(table.enabled),
  ],
);

// ---------------------------------------------------------------------------
// Rate limiting
//
// Postgres-backed, not in-memory: this app deploys as Vercel serverless
// functions (vercel.json's `crons` array only has meaning there), which
// routes concurrent requests across multiple isolated instances and cold-
// starts routinely - an in-memory Map's state isn't shared across any of
// that, so it couldn't actually enforce a limit under real traffic (every
// instance sees its own request as the first one). The database is the one
// piece of shared state every instance already has a connection to, so it's
// the natural place for this without introducing new infrastructure
// (Redis/Upstash) just for rate limiting. See lib/security/rate-limit.ts.
// ---------------------------------------------------------------------------

export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Observability - sync run tracking
//
// Every worker (sync/verify/rollup/alerts) writes one row here per
// invocation via lib/observability/sync-run.ts's withSyncRun: inserted at
// start (status "running"), updated to its final status when the worker
// settles - always, even on throw, so a crashed worker leaves a "failed"
// row rather than an eternally-"running" one. This is what answers "is my
// protocol sync actually working" without reading raw Vercel logs (see
// lib/observability/sync-health.ts). Deliberately generic across very
// different workers' own shapes (a per-chain sync vs. a single alerts
// sweep) - chain/block-range/provider-specific context goes in `metadata`
// rather than dedicated columns, so this table's shape doesn't need to
// change for every future worker.
// ---------------------------------------------------------------------------

export const syncRunStatusEnum = pgEnum("sync_run_status", ["running", "success", "partial", "failed"]);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    worker: varchar("worker", { length: 64 }).notNull(),
    status: syncRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    recordsProcessed: integer("records_processed"),
    recordsCreated: integer("records_created"),
    recordsUpdated: integer("records_updated"),
    errorCount: integer("error_count").default(0).notNull(),
    errorSummary: text("error_summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [index("sync_runs_worker_started_idx").on(table.worker, table.startedAt)],
);

// ---------------------------------------------------------------------------
// Indexing state foundation
//
// A generic, persistent cursor per (chain, component) - restart-safe (a
// worker always reads its position fresh from here rather than holding it
// only in memory) and concurrency-safe (a single atomic upsert per key, same
// pattern as rate_limit_buckets/lib/security/rate-limit.ts). This is
// deliberately just the state primitive: no block-scanning logic lives
// here. Not wired to any worker that indexes every protocol - only the
// small, deliberate event-ingestion example (lib/indexing/events.ts) uses
// it today.
// ---------------------------------------------------------------------------

export const indexingStateStatusEnum = pgEnum("indexing_state_status", ["idle", "running", "error"]);

export const indexingState = pgTable(
  "indexing_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chainSlug: varchar("chain_slug", { length: 64 }).notNull(),
    component: varchar("component", { length: 128 }).notNull(),
    lastProcessedBlock: numeric("last_processed_block", { precision: 20, scale: 0 }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastAttemptedSyncAt: timestamp("last_attempted_sync_at", { withTimezone: true }),
    status: indexingStateStatusEnum("status").notNull().default("idle"),
    error: text("error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("indexing_state_chain_component_unique").on(table.chainSlug, table.component)],
);

// ---------------------------------------------------------------------------
// Relations (enables db.query.* relational API)
// ---------------------------------------------------------------------------

export const chainsRelations = relations(chains, ({ many }) => ({
  protocolChains: many(protocolChains),
  metrics: many(chainMetrics),
  tokens: many(tokens),
  yieldPools: many(yieldPools),
}));

export const protocolsRelations = relations(protocols, ({ many }) => ({
  protocolChains: many(protocolChains),
  metrics: many(protocolMetrics),
  yieldPools: many(yieldPools),
  onchainVerifications: many(onchainVerifications),
}));

export const protocolChainsRelations = relations(protocolChains, ({ one }) => ({
  protocol: one(protocols, {
    fields: [protocolChains.protocolId],
    references: [protocols.id],
  }),
  chain: one(chains, {
    fields: [protocolChains.chainId],
    references: [chains.id],
  }),
}));

export const protocolMetricsRelations = relations(protocolMetrics, ({ one }) => ({
  protocol: one(protocols, {
    fields: [protocolMetrics.protocolId],
    references: [protocols.id],
  }),
  chain: one(chains, {
    fields: [protocolMetrics.chainId],
    references: [chains.id],
  }),
}));

export const chainMetricsRelations = relations(chainMetrics, ({ one }) => ({
  chain: one(chains, { fields: [chainMetrics.chainId], references: [chains.id] }),
}));

export const tokensRelations = relations(tokens, ({ one, many }) => ({
  chain: one(chains, { fields: [tokens.chainId], references: [chains.id] }),
  prices: many(tokenPrices),
}));

export const tokenPricesRelations = relations(tokenPrices, ({ one }) => ({
  token: one(tokens, { fields: [tokenPrices.tokenId], references: [tokens.id] }),
}));

export const yieldPoolsRelations = relations(yieldPools, ({ one }) => ({
  protocol: one(protocols, { fields: [yieldPools.protocolId], references: [protocols.id] }),
  chain: one(chains, { fields: [yieldPools.chainId], references: [chains.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  watchlist: many(watchlist),
  alerts: many(alerts),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const watchlistRelations = relations(watchlist, ({ one }) => ({
  user: one(users, { fields: [watchlist.userId], references: [users.id] }),
  protocol: one(protocols, { fields: [watchlist.protocolId], references: [protocols.id] }),
  chain: one(chains, { fields: [watchlist.chainId], references: [chains.id] }),
  token: one(tokens, { fields: [watchlist.tokenId], references: [tokens.id] }),
  yieldPool: one(yieldPools, { fields: [watchlist.yieldPoolId], references: [yieldPools.id] }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  user: one(users, { fields: [alerts.userId], references: [users.id] }),
}));

export const onchainVerificationsRelations = relations(onchainVerifications, ({ one }) => ({
  protocol: one(protocols, {
    fields: [onchainVerifications.protocolId],
    references: [protocols.id],
  }),
  chain: one(chains, {
    fields: [onchainVerifications.chainId],
    references: [chains.id],
  }),
}));

export const poolsRelations = relations(pools, ({ one, many }) => ({
  chain: one(chains, { fields: [pools.chainId], references: [chains.id] }),
  protocol: one(protocols, { fields: [pools.protocolId], references: [protocols.id] }),
  tokens: many(poolTokens),
}));

export const poolTokensRelations = relations(poolTokens, ({ one }) => ({
  pool: one(pools, { fields: [poolTokens.poolId], references: [pools.id] }),
}));

export const historicalObservationsRelations = relations(historicalObservations, ({ one }) => ({
  chain: one(chains, { fields: [historicalObservations.chainId], references: [chains.id] }),
}));
