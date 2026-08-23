# Database

PostgreSQL 16, Drizzle ORM (`lib/database/schema.ts` is the single source of
truth for the schema; migrations in `lib/database/migrations/` are
generated from it, never hand-written).

## Tables

| Table | Purpose | Notes |
|---|---|---|
| `chains` | The 8 supported chains | Seeded from `lib/config/chains.ts`, not synced from a provider |
| `chain_metrics` | Chain TVL, one row per `(chain_id, timestamp)` | Full history, backfilled once then appended to |
| `protocols` | Protocol metadata (name, category, description, logo) | |
| `protocol_chains` | Which chains a protocol is deployed on | Composite PK `(protocol_id, chain_id)` |
| `protocol_metrics` | TVL/fees/revenue/volume, one row per `(protocol_id, chain_id \| null, timestamp)` | `chain_id = null` means the aggregate-across-all-chains row; DefiLlama doesn't break fees/revenue/volume down per chain, only TVL |
| `protocol_ai_summaries` | Cached Claude-generated summary, one row per protocol | Regenerating overwrites in place (`protocol_id` is the PK) rather than accumulating history |
| `tokens` | Token metadata per chain deployment | One row per `(chain_id, address)` — the same token on 2 chains is 2 rows, since it's a different contract address on each |
| `token_prices` | Price/market cap/volume/24h change, one row per `(token_id, timestamp)` | |
| `yield_pools` | Yield pool snapshots | Current-state only, no history — DefiLlama's pools endpoint doesn't provide it |
| `users`, `accounts`, `verification_token` | Auth.js tables | No `sessions` table — JWT strategy doesn't need one |
| `watchlist` | User's watched protocols/chains/tokens | One of `protocol_id`/`chain_id`/`token_id` is set per row; three plain unique composite indexes `(user_id, protocol_id)` etc. enforce "at most one watch per user per entity" — Postgres treats each `NULL` as distinct in a unique index, so the two always-null columns on any given row don't collide with each other |
| `alerts` | User-defined threshold alerts | `type` + `target` (a slug/address/id) + `condition` + `threshold` |
| `onchain_verifications` | Latest DeFiHub-computed on-chain TVL per verified pool/read | One upserted row per key, no history — see `historical_observations` below. See [native-data.md](./native-data.md) |
| `sync_runs` | Per-worker sync run tracking (status/duration/counts) | Generic across workers via a `metadata` jsonb column |
| `indexing_state` | Generic `(chain_slug, component)` cursor for resumable indexing | Not wired to every worker — only the small event-ingestion example uses it today |
| `pools`, `pool_tokens` | Canonical AMM pools DeFiHub verifies on-chain, and the tokens each one holds | Synced from `lib/onchain/config.ts`'s `VERIFIED_POOLS` by `configKey`, not auto-discovered. See [native-data.md](./native-data.md) |
| `historical_observations` | Generic time series for DeFiHub-native calculated metrics | Rows are `(entity_type, entity_id, metric, timestamp)` — currently only `entityType: "pool"`, `metric: "tvl_usd"`. Deduped at *block* granularity (two partial unique indexes on `entity_type, entity_id, metric, block_number[, block_hash]`), not by `timestamp` — see [native-data.md](./native-data.md#reliability--security) |

## Design decisions worth knowing

**"Latest snapshot per entity" uses `DISTINCT ON`, not a `MAX(timestamp)`
subquery join, wherever entities can be at different timestamps.** Protocols
sync in a single batch (so `MAX(protocol_metrics.timestamp)` is a valid
proxy for "the latest sync run" — see `protocols.ts`), but tokens are synced
by two independent workers on different schedules (`sync:tokens` every 6h,
`sync:prices` every 15m), so no single `MAX()` is correct across all of
them. `lib/database/queries/tokens.ts`'s `latestPricePerToken` subquery uses
`selectDistinctOn([tokenPrices.tokenId], ...).orderBy(tokenId, timestamp desc)`
instead, which is correct per-token regardless of sync cadence.

**Composite indexes only serve queries that filter on their leading
column(s).** `tokens_chain_address_unique` is `(chain_id, address)` — fine
for "tokens on this chain," useless for "find this address on any chain"
(the actual shape of `getTokenByAddress`, used by both the app route and the
public API). `tokens_address_idx` exists as a standalone index specifically
for that lookup. When adding a new query, check whether it filters on a
column that's the *first* column of an existing composite index — if not,
it's probably doing a sequential scan.

**Migrations are one-way and applied in order.** `npm run db:generate`
diffs the current schema against the last migration and writes a new SQL
file; `npm run db:migrate` applies anything not yet applied, tracked in
Drizzle's own `__drizzle_migrations` table. There's no down-migration
tooling — a mistake gets fixed with a new forward migration, not a rollback.

## Adding a migration

1. Edit `lib/database/schema.ts`.
2. `npm run db:generate -- --name descriptive_name` — review the generated
   SQL in `lib/database/migrations/` before applying it.
3. `npm run db:migrate`.
4. If the change affects a query's performance characteristics, verify with
   `EXPLAIN` against the real local database rather than assuming an index
   helps — see the `tokens_address_idx` addition for the pattern (confirmed
   via `EXPLAIN` that the planner switched from a sequential scan to a
   bitmap index scan before considering it done).

## Local setup

```bash
npm run db:migrate   # create/update tables
npm run seed          # seed the 8 supported chains + their native tokens
npm run sync:all      # pull real data (see README for the full sync command list)
```
