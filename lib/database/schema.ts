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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

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
    uniqueIndex("protocol_metrics_unique_snapshot").on(
      table.protocolId,
      table.chainId,
      table.timestamp,
    ),
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
    decimals: integer("decimals").notNull().default(18),
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
// Auth.js (users / OAuth accounts / verification tokens)
// JWT session strategy is used (required by the Credentials provider), so no
// `sessions` table is needed.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  // null for OAuth-only accounts
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
